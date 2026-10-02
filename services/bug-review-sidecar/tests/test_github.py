import httpx
import pytest
from bug_review.github import GitHubCollector, ReviewError, parse_pr_url

def test_real_protocol_pagination_patch_gaps_and_token_not_persisted():
    requests = []
    def handler(request):
        requests.append(request)
        path = request.url.path
        if path.endswith('/pulls/8'):
            return httpx.Response(200,json={'merged': True,'title':'Handle upload','body':'Fixes #7','html_url':'https://github.com/a/b/pull/8','changed_files':2,'head':{'sha':'head'},'base':{'sha':'base'}})
        if path.endswith('/files'):
            if request.url.params['page'] == '1':
                return httpx.Response(200,json=[{'filename':'src/upload.ts','patch':'-bad\n+good','sha':'blob'}],headers={'link':'<https://api.github.com/ignored>; rel="next"'})
            return httpx.Response(200,json=[{'filename':'test/upload.test.ts','sha':'testblob'}])
        if path.endswith('/issues/7'):
            return httpx.Response(200,json={'title':'Upload error','body':'Actual reproduction','html_url':'https://github.com/a/b/issues/7'})
        if path.endswith('/check-runs'):
            return httpx.Response(403,json={'message':'secret-server-body'})
        if path.endswith('/status'):
            return httpx.Response(200,json={'statuses':[]})
        return httpx.Response(200,json=[])
    collector = GitHubCollector('secret-token',client=httpx.Client(transport=httpx.MockTransport(handler)))
    material = collector.collect(parse_pr_url('https://github.com/A/B/pull/8/files'))
    assert len(material['files']) == 2
    assert any(x['id'] == 'issue:a/b#7' for x in material['sources'])
    assert any('test/upload.test.ts' in gap for gap in material['gaps'])
    assert any('CI' in gap for gap in material['gaps'])
    assert all(r.headers['authorization'] == 'Bearer secret-token' for r in requests)
    assert 'secret-token' not in str(material)
    assert 'secret-server-body' not in str(material)

@pytest.mark.parametrize('url',['http://github.com/a/b/pull/1','https://github.com.evil/a/b/pull/1','https://github.com/a/b/issues/1'])
def test_invalid_input(url):
    with pytest.raises(ReviewError):
        parse_pr_url(url)

@pytest.mark.parametrize('status,code',[(401,'GITHUB_AUTH'),(403,'GITHUB_FORBIDDEN'),(404,'GITHUB_NOT_FOUND')])
def test_permission_errors(status,code):
    collector = GitHubCollector(client=httpx.Client(transport=httpx.MockTransport(lambda _:httpx.Response(status,json={'message':'sensitive'}))))
    with pytest.raises(ReviewError) as error:
        collector.collect(parse_pr_url('https://github.com/a/b/pull/1'))
    assert error.value.code == code
    assert 'sensitive' not in str(error.value)

def test_unmerged_pr_rejected():
    collector = GitHubCollector(client=httpx.Client(transport=httpx.MockTransport(lambda _:httpx.Response(200,json={'merged':False}))))
    with pytest.raises(ReviewError) as error:
        collector.collect(parse_pr_url('https://github.com/a/b/pull/1'))
    assert error.value.code == 'PR_NOT_MERGED'


def test_collection_budget_keeps_background_after_large_diff():
    def handler(request):
        path = request.url.path
        if path.endswith('/pulls/8'):
            return httpx.Response(200, json={'merged': True, 'title': 'Restore sources', 'body': '',
                'html_url': 'https://github.com/a/b/pull/8', 'head': {'sha': 'head'}})
        if path.endswith('/files'):
            return httpx.Response(200, json=[{'filename': 'large.vue', 'patch': '+' + 'x' * 20000},
                {'filename': '.gitignore', 'patch': '-research/\n+/research/'}])
        if path.endswith('/comments'):
            return httpx.Response(200, json=[{'id': 1, 'body': 'Author reported reproduction.'}])
        if path.endswith('/commits'):
            return httpx.Response(200, json=[{'sha': 'fix', 'commit': {'message': 'Limit ignore scope to root.'}}])
        if path.endswith('/status'):
            return httpx.Response(200, json={'statuses': []})
        if path.endswith('/check-runs'):
            return httpx.Response(200, json={'check_runs': []})
        return httpx.Response(200, json=[])
    collector = GitHubCollector(client=httpx.Client(transport=httpx.MockTransport(handler)), max_chars=500)
    material = collector.collect(parse_pr_url('https://github.com/a/b/pull/8'))
    selected = {s['id']: s['text'] for s in material['sources']}
    assert selected['comments:1'] == 'Author reported reproduction.'
    assert selected['commits:fix'] == 'Limit ignore scope to root.'
    assert '-research/\n+/research/' in selected['file:1']
    assert sum(len(s['text']) for s in material['sources']) <= 500
    assert any('file:0 超过材料字符预算' in gap for gap in material['gaps'])
