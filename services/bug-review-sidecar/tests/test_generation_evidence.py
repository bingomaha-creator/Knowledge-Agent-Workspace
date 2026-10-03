from copy import deepcopy
import json
import pytest
from fastapi.testclient import TestClient
from bug_review.api import create_app
from bug_review.extraction import QwenExtractor
from repo_maintainer.bug_schema import BugReviewDocument
from test_api import Extractor


class RestoreCollector:
    def collect(self, identity):
        return {'pr': {'title': 'fix: restore research sources', 'body': None}, 'files': [], 'gaps': [], 'checks': [],
                'sources': [
                    {'id': 'pr', 'type': 'pr_body', 'url': identity['url'], 'text': 'fix: restore research sources'},
                    {'id': 'file:0', 'type': 'diff', 'url': identity['url'] + '/files', 'text': '.gitignore\n@@ -1 +1 @@\n-research/\n+/research/'},
                    {'id': 'comment:1', 'type': 'pr_comment', 'url': identity['url'], 'text': '本地运行 build 成功；新增目录检查清单；页面未显示。'},
                ]}


def ref(location, snippet):
    return {'location': location, 'snippet': snippet}


def test_unsupported_claims_are_not_promoted_by_a_matching_diff_quote(tmp_path):
    class Unsupported(Extractor):
        def generate(self, material):
            doc = super().generate(material)
            doc.update(symptom='CI 产物缺失', validation='build 和 E2E 均通过', prevention='已落实检查清单', completeness='complete', gaps=[])
            doc['root_cause'].update(basis='fact', content='源码被忽略', source=ref('pr', 'fix: restore research sources'))
            doc['evidence'] = {'validation': [ref('file:0', '-research/\n+/research/')],
                               'prevention': {'implemented': [ref('comment:1', '编造的检查清单')], 'suggestions': ['检查业务目录是否纳入 Git。']}}
            return doc
    with TestClient(create_app(tmp_path, RestoreCollector(), Unsupported())) as client:
        rid = client.post('/api/bug-review/import', json={'url': 'https://github.com/demo/repo/pull/2'}).json()['review']['id']
        review = client.get('/api/bug-review/reviews/' + rid).json()['review']
        doc = review['document']
        assert '未提供' in doc['symptom'] and 'CI 产物缺失' not in doc['symptom']
        assert '未提供' in doc['validation'] and '均通过' not in doc['validation']
        assert '尚未确认落实' in doc['prevention'] and '已落实检查清单' not in doc['prevention']
        assert doc['root_cause']['basis'] == 'inference'
        assert doc['completeness'] == 'incomplete'
        assert review['material']['generated_document']['validation'] == 'build 和 E2E 均通过'
        assert review['status'] == 'draft' and review['published'] is None


def test_author_reports_remain_verbatim_and_human_edits_survive_regeneration(tmp_path):
    class Reported(Extractor):
        def generate(self, material):
            doc = super().generate(material)
            doc.update(symptom='不能冒充运行记录', validation='build、E2E 全通过', prevention='已上线完善流水线')
            doc['root_cause'].update(basis='fact', source=ref('file:0', '-research/\n+/research/'))
            doc['evidence'] = {'symptom': {'basis': 'fact', 'sources': [ref('comment:1', '页面未显示')]},
                               'validation': [ref('comment:1', '本地运行 build 成功')],
                               'prevention': {'implemented': [ref('comment:1', '新增目录检查清单')], 'suggestions': []}}
            return doc
    with TestClient(create_app(tmp_path, RestoreCollector(), Reported())) as client:
        rid = client.post('/api/bug-review/import', json={'url': 'https://github.com/demo/repo/pull/3'}).json()['review']['id']
        url = '/api/bug-review/reviews/' + rid
        review = client.get(url).json()['review']
        doc = deepcopy(review['document'])
        assert doc['symptom'] == '作者材料原文（本模块未独立复现）：\n页面未显示'
        assert doc['validation'] == '作者报告（本模块未执行验证）：本地运行 build 成功'
        assert 'E2E' not in doc['validation']
        assert doc['prevention'] == '作者报告的措施（未独立核验）：新增目录检查清单'
        assert doc['root_cause']['basis'] == 'inference'
        assert any(x['source_id'] == 'comment:1' for x in doc['source_refs'])
        doc['validation'] = '人工补充：已在本地核对构建。'
        edited = client.post(url + '/edit', json={'revision': review['revision'], 'document': doc}).json()['review']
        client.post(url + '/regenerate', json={'revision': edited['revision']})
        review = client.get(url).json()['review']
        assert review['document']['validation'] == doc['validation']
        assert review['candidate']['validation'].startswith('作者报告')
        assert review['published'] is None


@pytest.mark.parametrize('snippet', ['fix: restore research sources', 'restore research sources'])
def test_titles_and_unreferenced_symptoms_are_not_independent_evidence(tmp_path, snippet):
    class Titles(Extractor):
        def generate(self, material):
            doc = super().generate(material)
            doc['symptom'] = '组件不渲染、API 调用失败'
            title_ref = ref('pr', snippet)
            doc['root_cause'].update(basis='fact', source=title_ref)
            doc['evidence'] = {'symptom': {'basis': 'inference', 'sources': []},
                               'validation': [title_ref],
                               'prevention': {'implemented': [title_ref, title_ref], 'suggestions': []}}
            return doc
    with TestClient(create_app(tmp_path, RestoreCollector(), Titles())) as client:
        rid = client.post('/api/bug-review/import', json={'url': 'https://github.com/demo/repo/pull/8'}).json()['review']['id']
        doc = client.get('/api/bug-review/reviews/' + rid).json()['review']['document']
        assert '未提供' in doc['symptom'] and 'API' not in doc['symptom']
        assert '未提供' in doc['validation']
        assert 'fix: restore' not in doc['prevention']
        assert '作者报告的措施' not in doc['prevention']
        assert doc['root_cause']['basis'] == 'inference'


def test_diff_only_symptoms_and_impact_do_not_become_runtime_facts(tmp_path):
    class ChangedFiles(RestoreCollector):
        def collect(self, identity):
            material = super().collect(identity)
            material['files'] = [{'filename': '.gitignore'}, {'filename': 'src/features/research/api.ts'}]
            return material
    class Overconfident(Extractor):
        def generate(self, material):
            doc = super().generate(material)
            doc.update(symptom='全量用户无法调用 API', confidence=0.98)
            doc['impact'] = {'scope': '全站不可用', 'affected_users': '全量终端用户', 'severity': 'P1'}
            quote = ref('file:0', '-research/\n+/research/')
            doc['evidence'] = {'symptom': {'basis': 'inference', 'sources': [quote]}, 'impact': [quote]}
            return doc
    with TestClient(create_app(tmp_path, ChangedFiles(), Overconfident())) as client:
        rid = client.post('/api/bug-review/import', json={'url': 'https://github.com/demo/repo/pull/9'}).json()['review']['id']
        url = '/api/bug-review/reviews/' + rid
        review = client.get(url).json()['review']
        doc = review['document']
        assert '未提供' in doc['symptom'] and '全量用户' not in doc['symptom']
        assert doc['impact']['severity'] == 'unknown' and doc['impact']['affected_users'] is None
        assert doc['impact']['scope'] == '变更涉及文件（不代表实际故障影响）：\n.gitignore\nsrc/features/research/api.ts'
        assert 'confidence' not in doc
        assert review['material']['generated_document']['confidence'] == 0.98
        approved = client.post(url + '/approve', json={'revision': review['revision']}).json()['review']
        published = client.post(url + '/publish', json={'revision': approved['revision']}).json()['review']
        exports = list((tmp_path / 'markdown').glob('*.md'))
        assert len(exports) == 1
        markdown = exports[0].read_text()
        assert '严重程度**: 待确认' in markdown and '未提供可靠性评分' in markdown and '98%' not in markdown
        doc['impact'] = {'scope': '人工确认：测试用户登录受影响', 'affected_users': '测试用户', 'severity': 'P2'}
        edited = client.post(url + '/edit', json={'revision': published['revision'], 'document': doc}).json()['review']
        client.post(url + '/regenerate', json={'revision': edited['revision']})
        review = client.get(url).json()['review']
        assert review['document']['impact'] == doc['impact']
        assert review['candidate']['impact']['severity'] == 'unknown'
        assert review['published']['document']['impact']['severity'] == 'unknown'


def test_reported_impact_is_retained_verbatim_without_guessed_severity(tmp_path):
    class Reported(Extractor):
        def generate(self, material):
            doc = super().generate(material)
            doc['evidence'] = {'impact': [ref('comment:1', '页面未显示')]}
            return doc
    with TestClient(create_app(tmp_path, RestoreCollector(), Reported())) as client:
        rid = client.post('/api/bug-review/import', json={'url': 'https://github.com/demo/repo/pull/12'}).json()['review']['id']
        doc = client.get('/api/bug-review/reviews/' + rid).json()['review']['document']
        assert doc['impact']['scope'] == '作者报告的影响（未独立核验）：\n页面未显示'
        assert doc['impact']['severity'] == 'unknown'


def test_ci_states_do_not_inherit_unrelated_model_validation(tmp_path):
    class CICollector(RestoreCollector):
        def collect(self, identity):
            material = super().collect(identity)
            material['checks'] = [{'context': 'unit', 'state': 'success'}, {'context': 'build', 'state': 'failure'}]
            return material
    with TestClient(create_app(tmp_path, CICollector(), Extractor())) as client:
        rid = client.post('/api/bug-review/import', json={'url': 'https://github.com/demo/repo/pull/4'}).json()['review']['id']
        doc = client.get('/api/bug-review/reviews/' + rid).json()['review']['document']
        assert 'unit: success' in doc['validation'] and 'build: failure' in doc['validation']
        assert '不证明根因' in doc['validation']


def test_generated_quotes_must_be_in_the_actual_model_input(tmp_path):
    class Unseen(Extractor):
        def generate(self, material):
            material['model_sources'] = [{**s, 'text': ''} for s in material['sources']]
            doc = super().generate(material)
            doc['evidence'] = {'validation': [ref('comment:1', '本地运行 build 成功')]}
            return doc
    with TestClient(create_app(tmp_path, RestoreCollector(), Unseen())) as client:
        rid = client.post('/api/bug-review/import', json={'url': 'https://github.com/demo/repo/pull/5'}).json()['review']['id']
        doc = client.get('/api/bug-review/reviews/' + rid).json()['review']['document']
        assert '未提供' in doc['validation']
        assert doc['source_refs'] == []


@pytest.mark.parametrize('location', [{}, []])
def test_invalid_reference_types_keep_a_conservative_draft(tmp_path, location):
    class Malformed(Extractor):
        def generate(self, material):
            doc = super().generate(material)
            doc['evidence'] = {'validation': [ref(location, '本地运行 build 成功')]}
            return doc
    with TestClient(create_app(tmp_path, RestoreCollector(), Malformed())) as client:
        rid = client.post('/api/bug-review/import', json={'url': 'https://github.com/demo/repo/pull/6'}).json()['review']['id']
        review = client.get('/api/bug-review/reviews/' + rid).json()['review']
        assert review['task']['status'] == 'completed'
        assert '未提供' in review['document']['validation']
        assert review['material']['generated_document']['evidence']['validation'][0]['location'] == location


def test_invalid_generated_document_retains_raw_output(tmp_path):
    class Invalid(Extractor):
        def generate(self, material):
            doc = super().generate(material)
            doc['title'] = ''
            return doc
    with TestClient(create_app(tmp_path, RestoreCollector(), Invalid())) as client:
        rid = client.post('/api/bug-review/import', json={'url': 'https://github.com/demo/repo/pull/7'}).json()['review']['id']
        review = client.get('/api/bug-review/reviews/' + rid).json()['review']
        assert review['task']['status'] == 'failed'
        assert review['material']['generated_document']['title'] == ''
        assert review['document'] is None


def test_model_budget_keeps_late_background_and_all_diff_headers(monkeypatch):
    monkeypatch.setenv('QWEN_CONTEXT_WINDOW_TOKENS', '10000')
    material = RestoreCollector().collect({'url': 'https://github.com/demo/repo/pull/2'})
    material['sources'].insert(1, {'id': 'file:large', 'type': 'diff', 'url': '', 'text': 'large.vue\n' + 'x' * 20000})
    material['sources'].append({'id': 'commit:1', 'type': 'commit_message', 'url': '', 'text': 'Limit ignore rule to root; restore nested research module.'})
    captured = []
    class Executor:
        def is_configured(self):
            return True
        def generate_bug_review(self, report, **kwargs):
            captured.extend(json.loads(kwargs['source_text']))
            return BugReviewDocument.from_dict(Extractor().generate(material))
    extractor = QwenExtractor()
    extractor.executor = Executor()
    extractor.generate(material)
    selected = {s['id']: s['text'] for s in captured}
    assert sum(len(s['text']) for s in captured) <= 1500
    assert selected['commit:1'] == material['sources'][-1]['text']
    assert selected['comment:1'] == material['sources'][-2]['text']
    assert '-research/\n+/research/' in selected['file:0']
    assert selected['file:large'].startswith('large.vue\n')
    assert material['model_gaps'] == ['file:large 在模型上下文中截断。']
