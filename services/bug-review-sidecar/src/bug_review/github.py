from __future__ import annotations
import re
from datetime import datetime, timezone
from urllib.parse import urlsplit
import httpx

class ReviewError(Exception):
    def __init__(self, code, message, status=400):
        self.code, self.message, self.status = code, message, status
        super().__init__(message)

def select_sources(sources, budget):
    """Reserve background space, then share each group's budget across sources."""
    background = [s for s in sources if s['type'] != 'diff']
    diffs = [s for s in sources if s['type'] == 'diff']
    background_size = sum(len(s['text']) for s in background)
    diff_size = sum(len(s['text']) for s in diffs)
    background_budget = min(background_size, budget if not diffs else budget // 3)
    diff_budget = min(diff_size, budget - background_budget)
    background_budget = min(background_size, budget - diff_budget)
    slices = {}
    for group, remaining in [(background, background_budget), (diffs, diff_budget)]:
        # Short sources remain whole; large files share the remaining space.
        ordered = sorted(group, key=lambda s: len(s['text']))
        for index, source in enumerate(ordered):
            text = source['text'][:remaining // (len(ordered) - index)]
            remaining -= len(text)
            slices[source['id']] = text
    return [{**source, 'text': slices[source['id']]} for source in sources]

def parse_pr_url(value):
    try:
        parsed = urlsplit(value.strip())
        match = re.fullmatch(r'/([\w.-]+)/([\w.-]+)/pull/([1-9]\d*)(?:/(?:files|commits))?/?', parsed.path)
        if parsed.scheme != 'https' or parsed.netloc.lower() != 'github.com' or not match:
            raise ValueError()
        owner, repo, number = match.groups()
        return {'owner': owner.lower(), 'repo': repo.lower(), 'number': int(number),
                'url': f'https://github.com/{owner.lower()}/{repo.lower()}/pull/{int(number)}'}
    except (ValueError, AttributeError):
        raise ReviewError('INVALID_PR_URL', '请输入 github.com 上的 GitHub PR 链接。')

class GitHubCollector:
    def __init__(self, token='', client=None, max_pages=10, max_chars=160000):
        self.client = client or httpx.Client(timeout=30, follow_redirects=False)
        self.headers = {'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'knowledge-agent-bug-review'}
        if token:
            self.headers['Authorization'] = 'Bearer ' + token
        self.max_pages, self.max_chars = max_pages, max_chars

    def request(self, path, params=None):
        try:
            response = self.client.get('https://api.github.com' + path, headers=self.headers, params=params)
        except httpx.HTTPError:
            raise ReviewError('GITHUB_UNAVAILABLE', 'GitHub 连接失败，请稍后重试。', 502)
        if response.status_code != 200:
            code, message = {
                401: ('GITHUB_AUTH', 'GitHub 凭据失效，请检查后端 Token。'),
                403: ('GITHUB_FORBIDDEN', 'GitHub 权限、组织授权或调用额度不足。'),
                404: ('GITHUB_NOT_FOUND', 'PR 不存在或后端凭据无权访问。'),
                429: ('GITHUB_RATE_LIMIT', 'GitHub 调用额度不足，请稍后重试。')
            }.get(response.status_code, ('GITHUB_ERROR', 'GitHub 采集失败。'))
            raise ReviewError(code, message, 502)
        return response.json(), response.headers.get('link', '')

    def pages(self, path, gaps, label, optional=False):
        items = []
        for page in range(1, self.max_pages + 1):
            try:
                batch, link = self.request(path, {'per_page': 100, 'page': page})
            except ReviewError as error:
                if not optional:
                    raise
                gaps.append(f'{label}获取失败：{error.message}')
                return items
            if not isinstance(batch, list):
                raise ReviewError('GITHUB_PROTOCOL', 'GitHub 返回了异常的分页材料。', 502)
            items.extend(batch)
            if 'rel="next"' not in link:
                return items
        gaps.append(f'{label}超过 {self.max_pages * 100} 条采集上限，材料不完整。')
        return items

    def collect(self, identity):
        owner, repo, number = identity['owner'], identity['repo'], identity['number']
        base = f'/repos/{owner}/{repo}'
        pr, _ = self.request(f'{base}/pulls/{number}')
        if not pr.get('merged'):
            raise ReviewError('PR_NOT_MERGED', '第一阶段仅支持已合入的 PR。', 422)
        gaps, sources = [], []
        def source(source_id, kind, url, text):
            sources.append({'id': source_id, 'type': kind, 'url': url, 'text': text or ''})
        source('pr', 'pr_body', pr['html_url'], (pr.get('title') or '') + '\n' + (pr.get('body') or ''))
        if not pr.get('body'):
            gaps.append('PR 描述为空，修复背景需要人工补充。')
        files = self.pages(f'{base}/pulls/{number}/files', gaps, '变更文件')
        if len(files) < pr.get('changed_files', len(files)):
            gaps.append('GitHub 未返回全部变更文件（可能达到 API 上限）。')
        for index, file in enumerate(files):
            if not file.get('patch'):
                gaps.append(f"{file['filename']} 没有可用 patch（可能为二进制或 GitHub 截断）。")
            source(f'file:{index}', 'diff', pr['html_url'] + '/files#diff-' + __import__('hashlib').sha256(file['filename'].encode()).hexdigest(),
                   file['filename'] + '\n' + (file.get('patch') or ''))
        collections = [
            ('comments', f'{base}/issues/{number}/comments', 'PR 评论', 'pr_comment'),
            ('reviews', f'{base}/pulls/{number}/reviews', 'Review', 'pr_comment'),
            ('inline', f'{base}/pulls/{number}/comments', '行内评论', 'pr_comment'),
            ('commits', f'{base}/pulls/{number}/commits', 'Commit', 'commit_message')]
        for kind, path, label, source_type in collections:
            for item in self.pages(path, gaps, label, optional=kind != 'commits'):
                text = item.get('commit', {}).get('message', '') if kind == 'commits' else item.get('body', '')
                if kind == 'inline':
                    text = f"{item.get('path')}:{item.get('line') or item.get('original_line')}\n{text}"
                source(f'{kind}:{item.get("id") or item.get("sha")}', source_type, item.get('html_url') or pr['html_url'], text)
        # Explicit closing references in PR body; not an arbitrary Issue crawl.
        references = set()
        for match in re.finditer(r'\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:#(\d+)|https://github\.com/([\w.-]+)/([\w.-]+)/issues/(\d+))', pr.get('body') or '', re.I):
            references.add((match[2] or owner, match[3] or repo, int(match[1] or match[4])))
        for io, ir, ino in sorted(references)[:10]:
            try:
                issue, _ = self.request(f'/repos/{io}/{ir}/issues/{ino}')
                source(f'issue:{io}/{ir}#{ino}', 'issue', issue['html_url'], issue['title'] + '\n' + (issue.get('body') or ''))
            except ReviewError as error:
                gaps.append(f'关联 Issue {io}/{ir}#{ino} 获取失败：{error.message}')
        if len(references) > 10:
            gaps.append('关联 Issue 超过 10 条上限，已截断。')
        sha = pr.get('head', {}).get('sha')
        checks = []
        if sha:
            try:
                status, _ = self.request(f'{base}/commits/{sha}/status')
                check_data, _ = self.request(f'{base}/commits/{sha}/check-runs', {'per_page': 100})
                checks = [{'context': x.get('context'), 'state': x.get('state'), 'url': x.get('target_url')} for x in status.get('statuses', [])]
                checks += [{'context': x.get('name'), 'state': x.get('conclusion') or x.get('status'), 'url': x.get('html_url')} for x in check_data.get('check_runs', [])]
                if check_data.get('total_count', 0) > 100:
                    gaps.append('CI 检查超过 100 条上限，未全部采集。')
                if not checks:
                    gaps.append('没有可用的 CI 检查结果。')
                source('ci', 'ci', pr['html_url'] + '/checks', __import__('json').dumps(checks, ensure_ascii=False))
            except ReviewError as error:
                gaps.append('CI 辅助材料获取失败：' + error.message)
        selected = select_sources(sources, self.max_chars)
        gaps += [source['id'] + ' 超过材料字符预算，已截断。' for source, kept in zip(sources, selected)
                 if len(source['text']) != len(kept['text'])]
        return {'pr': {key: pr.get(key) for key in ['title', 'body', 'html_url', 'merged', 'merged_at', 'merge_commit_sha', 'number']},
                'identity': identity, 'head_sha': sha, 'base_sha': pr.get('base', {}).get('sha'),
                'collected_at': datetime.now(timezone.utc).isoformat(),
                'files': [{key: item.get(key) for key in ['filename', 'status', 'additions', 'deletions', 'sha']} for item in files],
                'sources': selected, 'gaps': gaps, 'checks': checks}
