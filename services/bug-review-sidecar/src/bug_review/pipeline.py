from __future__ import annotations
from copy import deepcopy
from hashlib import sha256
import json
import re
import math
from pathlib import Path
from threading import RLock
from uuid import uuid4
from repo_maintainer.bm25_index import BM25Document, BM25Index
from repo_maintainer.review_workflow import ReviewWorkflowEngine, ReviewStatus
from repo_maintainer.wiki_publisher import WikiPublisherService
from repo_maintainer.models import iso_now
from .github import ReviewError, parse_pr_url

ACTIVE = {'queued', 'collecting', 'generating'}

class Pipeline:
    def __init__(self, data_dir, collector, extractor):
        self.root = Path(data_dir)
        self.cases = self.root / 'reviews'
        self.cases.mkdir(parents=True, exist_ok=True)
        self.lock = RLock()
        self.collector, self.extractor = collector, extractor
        self.workflow = ReviewWorkflowEngine(storage_dir=self.root)
        self.publisher = WikiPublisherService(output_dir=self.root / 'markdown')
        self.index = BM25Index(self.root / 'index.sqlite')
        for review in self.all():
            if review['task']['status'] in ACTIVE:
                review['task'].update(status='failed', error={'code': 'INTERRUPTED', 'message': '服务重启中断了任务，请显式重试。'})
                self.save(review)
            if review.get('published'):
                self.index_published(review)

    def save(self, review):
        review['updated_at'] = iso_now()
        review['revision'] += 1
        path = self.cases / (review['id'] + '.json')
        temporary = path.with_suffix('.tmp')
        temporary.write_text(json.dumps(review, ensure_ascii=False, indent=2), encoding='utf-8')
        temporary.replace(path)
        return deepcopy(review)

    def get(self, review_id):
        if not re.fullmatch(r'[a-f0-9]{24}', review_id):
            raise ReviewError('NOT_FOUND', '复盘不存在。', 404)
        path = self.cases / (review_id + '.json')
        if not path.exists():
            raise ReviewError('NOT_FOUND', '复盘不存在。', 404)
        return json.loads(path.read_text(encoding='utf-8'))

    def all(self):
        return sorted([json.loads(path.read_text(encoding='utf-8')) for path in self.cases.glob('*.json')], key=lambda x: x['updated_at'], reverse=True)

    def import_pr(self, url):
        identity = parse_pr_url(url)
        review_id = sha256(identity['url'].encode()).hexdigest()[:24]
        with self.lock:
            if (self.cases / (review_id + '.json')).exists():
                return self.get(review_id), False
            review = {'id': review_id, 'identity': identity, 'revision': 0, 'status': 'draft', 'created_at': iso_now(),
                      'updated_at': iso_now(), 'material': None, 'document': None, 'document_material': None, 'candidate': None, 'candidate_material': None, 'published': None, 'history': [],
                      'task': {'id': str(uuid4()), 'status': 'queued', 'error': None, 'operation': 'import'}}
            return self.save(review), True

    def schedule(self, review_id, operation, revision):
        with self.lock:
            review = self.check(review_id, revision)
            review['task'] = {'id': str(uuid4()), 'status': 'queued', 'error': None, 'operation': operation}
            return self.save(review)

    def run(self, review_id):
        try:
            with self.lock:
                review = self.get(review_id)
                operation = review['task']['operation']
                review['task']['status'] = 'generating' if operation == 'regenerate' else 'collecting'
                self.save(review)
            if operation != 'regenerate':
                material = self.collector.collect(review['identity'])
                with self.lock:
                    review = self.get(review_id)
                    review['material'] = material
                    self.save(review)
            material = deepcopy(review['material'])
            if material is None:
                raise ReviewError('MATERIAL_MISSING', '请先重新采集材料。', 409)
            if operation != 'refresh':
                with self.lock:
                    review = self.get(review_id)
                    review['task']['status'] = 'generating'
                    self.save(review)
                document = self.extractor.generate(material)
                material['generated_document'] = deepcopy(document)
                with self.lock:
                    review = self.get(review_id)
                    review['material'] = deepcopy(material)
                    self.save(review)
                document = self.validate_document(document, material, generated=True)
                with self.lock:
                    review = self.get(review_id)
                    review['material'] = material
                    if review['document'] is None:
                        review['document'] = document
                        review['document_material'] = deepcopy(material)
                    else:
                        review['candidate'] = document
                        review['candidate_material'] = deepcopy(material)
                    self.save(review)
            with self.lock:
                review = self.get(review_id)
                review['task'].update(status='completed', error=None)
                self.save(review)
        except Exception as error:
            with self.lock:
                review = self.get(review_id)
                review['task'].update(status='failed', error={
                    'code': error.code if isinstance(error, ReviewError) else 'TASK_FAILED',
                    'message': error.message if isinstance(error, ReviewError) else '任务失败，已保存的内容保留。'})
                self.save(review)

    def validate_document(self, document, material, human=False, generated=False):
        if not isinstance(document, dict):
            raise ReviewError('INVALID_DOCUMENT', '复盘必须是结构化对象。', 422)
        doc = deepcopy(document)
        for key in ['title', 'fix_solution', 'prevention']:
            if not isinstance(doc.get(key), str) or not doc[key].strip():
                raise ReviewError('INVALID_DOCUMENT', f'{key} 不能为空。', 422)
        for key in ['symptom', 'validation', 'human_notes']:
            doc.setdefault(key, '')
            if not isinstance(doc[key], str):
                raise ReviewError('INVALID_DOCUMENT', key + ' 必须是文本。', 422)
        impact = doc.get('impact')
        if not isinstance(impact, dict) or not isinstance(impact.get('scope'), str) or impact.get('severity') not in ['P0', 'P1', 'P2', 'P3', 'unknown']:
            raise ReviewError('INVALID_DOCUMENT', '影响评估格式错误。', 422)
        confidence = doc.get('confidence', 0)
        if not isinstance(confidence, (float, int)) or not math.isfinite(confidence) or not 0 <= confidence <= 1:
            raise ReviewError('INVALID_DOCUMENT', 'confidence 必须在 0–1 范围内。', 422)
        root = doc.get('root_cause')
        if not isinstance(root, dict) or not isinstance(root.get('content'), str) or not root['content'].strip():
            raise ReviewError('INVALID_DOCUMENT', '根因不能为空；可填写待确认。', 422)
        if root.get('basis') not in ['fact', 'inference', 'human']:
            raise ReviewError('INVALID_DOCUMENT', '请标记根因依据为事实、推断或人工补充。', 422)
        if not human and root['basis'] == 'human':
            root['basis'] = 'inference'
        for key in ['gaps', 'keywords', 'related_modules', 'source_refs']:
            doc.setdefault(key, [])
            if not isinstance(doc[key], list):
                raise ReviewError('INVALID_DOCUMENT', key + ' 必须是数组。', 422)
        for key in ['gaps', 'keywords', 'related_modules']:
            if any(not isinstance(x, str) for x in doc[key]):
                raise ReviewError('INVALID_DOCUMENT', key + ' 必须是字符串数组。', 422)
        snapshot = material or {}
        sources = {x['id']: x for x in snapshot.get('model_sources' if generated and 'model_sources' in snapshot else 'sources', [])}
        gaps = list((material or {}).get('gaps', [])) + list((material or {}).get('model_gaps', [])) + doc['gaps']
        def bind(ref):
            if not isinstance(ref, dict):
                raise ReviewError('INVALID_DOCUMENT', '来源格式错误。', 422)
            sid, snippet = ref.get('location'), ref.get('snippet')
            if isinstance(sid, str) and sid in sources and isinstance(snippet, str) and snippet.strip() and snippet.replace('\r\n', '\n') in sources[sid]['text'].replace('\r\n', '\n'):
                return {**ref, 'source_id': sid, 'url': sources[sid]['url'], 'type': sources[sid]['type']}
            return None
        root_ref = bind(root.get('source') or {})
        root['source'] = root_ref or {}
        refs = [bind(ref) for ref in doc['source_refs']]
        if any(ref is None for ref in refs):
            gaps.append('生成或提交的部分来源无法与原文绑定，已移除。')
        doc['source_refs'] = [ref for ref in refs if ref]
        if generated:
            # A matching quote proves traceability, not semantic entailment. Keep
            # reported evidence verbatim and leave independent verification to humans.
            evidence = doc.pop('evidence', {})
            evidence = evidence if isinstance(evidence, dict) else {}
            def grounded_refs(value, allowed):
                if not isinstance(value, list):
                    return []
                result = []
                for ref in value:
                    bound = bind(ref) if isinstance(ref, dict) else None
                    if bound and bound['type'] in allowed:
                        source_text = sources[bound['source_id']]['text'].replace('\r\n', '\n')
                        title = snapshot.get('pr', {}).get('title', '').strip()
                        # The collector prepends the PR title to its body source.
                        # A title (or any substring of it) is no independent report.
                        if bound['source_id'] == 'pr':
                            source_text = source_text.partition('\n')[2]
                        elif source_text.strip() == title:
                            source_text = ''
                        if bound['snippet'].replace('\r\n', '\n') not in source_text:
                            continue
                        if bound not in result:
                            result.append(bound)
                        if bound not in doc['source_refs']:
                            doc['source_refs'].append(bound)
                return result
            narrative = {'pr_body', 'pr_comment', 'commit_message', 'issue', 'log'}
            symptom = evidence.get('symptom', {})
            symptom = symptom if isinstance(symptom, dict) else {}
            symptom_refs = grounded_refs(symptom.get('sources'), narrative)
            if symptom_refs:
                doc['symptom'] = '作者材料原文（本模块未独立复现）：\n' + '\n'.join(ref['snippet'] for ref in symptom_refs)
            else:
                doc['symptom'] = '未提供明确的故障现象或运行记录。'
                gaps.append('问题现象缺少独立依据，未采用模型的确定性描述。')
            impact_refs = grounded_refs(evidence.get('impact'), narrative)
            filenames = [item['filename'] for item in snapshot.get('files', [])]
            impact['scope'] = ('作者报告的影响（未独立核验）：\n' + '\n'.join(ref['snippet'] for ref in impact_refs)
                               if impact_refs else '变更涉及文件（不代表实际故障影响）：\n' + '\n'.join(filenames)
                               if filenames else '未提供可追溯的实际影响范围。')
            impact['affected_users'] = None
            impact['severity'] = 'unknown'
            gaps.append('实际受影响用户和严重程度待人工确认，未采用模型的自动评级。')
            # A model self-score is not a calibrated reliability measurement.
            doc.pop('confidence', None)
            validation_refs = grounded_refs(evidence.get('validation'), narrative)
            validation = ['作者报告（本模块未执行验证）：' + ref['snippet'] for ref in validation_refs]
            checks = snapshot.get('checks', [])
            if checks:
                validation.append('GitHub 检查状态（不证明根因或本模块复现）：\n' + '\n'.join(
                    str(check.get('context') or '未命名检查') + ': ' + str(check.get('state') or '未知') for check in checks))
            if not validation:
                validation = ['未提供可追溯的验证结果；本模块未执行目标仓库构建或测试。']
                gaps.append('验证结论缺少独立依据，未采用模型的验证成功描述。')
            doc['validation'] = '\n'.join(validation)
            prevention = evidence.get('prevention', {})
            prevention = prevention if isinstance(prevention, dict) else {}
            implemented = grounded_refs(prevention.get('implemented'), narrative | {'diff'})
            suggestions = prevention.get('suggestions', [])
            suggestions = [x.strip() for x in suggestions if isinstance(x, str) and x.strip()] if isinstance(suggestions, list) else []
            lines = [('变更证据（落实范围需人工核对）：' if ref['type'] == 'diff' else '作者报告的措施（未独立核验）：') + ref['snippet'] for ref in implemented]
            lines += ['建议（尚未确认落实）：' + text for text in suggestions]
            doc['prevention'] = '\n'.join(lines) or '建议：补充实际故障和修复验证记录，审核后再发布。'
            if not implemented:
                gaps.append('没有已落实规避措施的独立证据，仅保留建议。')
            if root['basis'] == 'fact' and root_ref and (
                root_ref['type'] in {'diff', 'ci'} or
                sources[root_ref['source_id']]['text'].strip() == snapshot.get('pr', {}).get('title', '').strip() or
                (root_ref['source_id'] == 'pr' and root_ref['snippet'].replace('\r\n', '\n') not in
                 sources['pr']['text'].replace('\r\n', '\n').partition('\n')[2])
            ):
                root['basis'] = 'inference'
                gaps.append('根因引用仅为代码变更、检查状态或 PR 标题，按推断处理。')
        if root['basis'] == 'fact' and not root_ref:
            root['basis'] = 'inference'
        if root['basis'] != 'human' and not root_ref:
            gaps.append('根因没有可追溯原文，需要人工核对。')
        if root['basis'] == 'inference':
            gaps.append('根因属于推断，尚未取得事实确认。')
        if root['basis'] == 'human' and not doc.get('human_notes', '').strip():
            gaps.append('人工根因尚未填写补充背景。')
        doc['gaps'] = list(dict.fromkeys(gaps))
        if doc.get('completeness') not in ['complete', 'incomplete']:
            doc['completeness'] = 'incomplete'
        if doc['gaps']:
            doc['completeness'] = 'incomplete'
        doc.setdefault('human_notes', '')
        return doc

    def check(self, review_id, revision):
        review = self.get(review_id)
        if review['revision'] != revision:
            raise ReviewError('CONFLICT', '记录已更新，请刷新后再操作。', 409)
        if review['task']['status'] in ACTIVE:
            raise ReviewError('TASK_ACTIVE', '任务正在执行，请等待完成。', 409)
        return review

    def transition(self, review, target, notes=''):
        # Case JSON is authoritative; upstream history is an audit mirror only.
        success, message, _ = self.workflow.transition(bug_report_id=review['id'], to_status=ReviewStatus(target),
             current_status=ReviewStatus(review['status']), reviewer='workspace-user', notes=notes)
        if not success:
            raise ReviewError('REVIEW_CONFLICT', message, 409)
        review['history'].append(self.workflow.get_history(review['id'])[-1])
        review['status'] = target

    def act(self, review_id, operation, revision, document=None, notes=''):
        with self.lock:
            review = self.check(review_id, revision)
            if operation in ['edit', 'adopt']:
                incoming = review['candidate'] if operation == 'adopt' else document
                if not incoming:
                    raise ReviewError('NO_CANDIDATE', '没有可采用的生成结果。', 409)
                material = review['candidate_material'] if operation == 'adopt' else review['document_material']
                checked = self.validate_document(incoming, material, human=operation == 'edit')
                if operation == 'edit':
                    changed = [key for key in ['title', 'symptom', 'root_cause', 'impact', 'fix_solution', 'prevention', 'validation', 'human_notes', 'keywords', 'gaps', 'completeness'] if checked.get(key) != (review['document'] or {}).get(key)]
                    checked['human_edits'] = list(dict.fromkeys((review['document'] or {}).get('human_edits', []) + changed))
                review['document'] = checked
                review['document_material'] = deepcopy(material)
                review['status'] = 'draft'
                review['history'].append({'action': operation, 'reviewer': 'workspace-user', 'created_at': iso_now(), 'notes': '人工编辑' if operation == 'edit' else '采用生成结果'})
                if operation == 'adopt':
                    review['candidate'] = None
                    review['candidate_material'] = None
            elif operation == 'discard':
                review['candidate'] = None
                review['candidate_material'] = None
            elif operation == 'approve':
                review['document'] = self.validate_document(review['document'], review['document_material'], human=True)
                if review['status'] in ['draft', 'rejected']:
                    self.transition(review, 'pending')
                self.transition(review, 'approved', notes)
            elif operation == 'reject':
                if not notes.strip():
                    raise ReviewError('REASON_REQUIRED', '驳回需要填写原因。', 422)
                self.transition(review, 'rejected', notes)
            elif operation == 'publish':
                if review['status'] != 'approved':
                    raise ReviewError('REVIEW_CONFLICT', '请先审核通过，再发布。', 409)
                document = self.validate_document(review['document'], review['document_material'], human=True)
                document['review_status'] = 'published'
                published = {'document': deepcopy(document), 'published_at': iso_now(), 'revision': review['revision'] + 1,
                             'material': deepcopy(review['document_material'])}
                original = deepcopy(review)
                review['published'] = published
                try:
                    markdown = self.markdown(document)
                    export = self.publisher.publish(bug_report_id=review_id + '-' + str(published['revision']), title=document['title'], content=markdown)
                    if export.get('status') != 'published':
                        raise OSError('Markdown export failed')
                    self.index_published(review)
                    self.transition(review, 'published', notes)
                    return self.save(review)
                except Exception:
                    if original.get('published'):
                        self.index_published(original)
                    else:
                        self.index.remove_document(review_id, 'bug_review')
                    raise ReviewError('PUBLISH_FAILED', '发布失败，原发布内容保留，可重试。', 502)
            else:
                raise ReviewError('INVALID_OPERATION', '不支持的操作。')
            return self.save(review)

    def markdown(self, doc):
        body = self.publisher.render_markdown(doc['title'], doc, '', doc['keywords'])
        detail = '\n'.join('- ' + gap for gap in doc['gaps'])
        sources = '\n'.join(f"- {ref.get('source_id')}: {ref.get('url')}\n  {ref.get('snippet')}" for ref in [doc['root_cause'].get('source', {})] + doc['source_refs'] if ref)
        return body + f"\n## 问题现象\n{doc.get('symptom', '未提供')}\n\n## 验证依据\n{doc.get('validation', '未提供')}\n\n## 证据完整性\n{doc['completeness']}\n{detail}\n\n根因依据：{doc['root_cause']['basis']}\n人工补充：{doc.get('human_notes', '')}\n\n## 来源\n{sources}\n"

    def index_published(self, review):
        doc = review['published']['document']
        self.index.index_document(BM25Document(doc_id=review['id'], doc_type='bug_review', title=doc['title'], body=self.markdown(doc), keywords=doc['keywords']))

    def library(self, query=''):
        with self.lock:
            reviews = self.all()
            if query.strip():
                ids = [hit.doc_id for hit in self.index.search(query, doc_types=['bug_review'], limit=50)]
                reviews = sorted([r for r in reviews if r['id'] in ids], key=lambda r: ids.index(r['id']))
            return [{'id': r['id'], 'identity': r['identity'], **r['published']} for r in reviews if r.get('published')]
