from fastapi.testclient import TestClient
from bug_review.api import create_app

class Collector:
    calls = 0
    def collect(self, identity):
        self.calls += 1
        return {"pr": {"title": "Handle upload", "body": "", "url": identity['url'], "merged": True},
                "sources": [{"id": "pr", "type": "pr_body", "url": identity['url'], "text": "Handle upload"}],
                "gaps": ["PR 没有根因说明"], "files": []}

class Extractor:
    def generate(self, material):
        return {"title": "Upload error", "symptom": "上传失败", "root_cause": {"content": "待确认", "basis": "inference", "source": {}},
                "impact": {"scope": "upload", "severity": "P2"}, "fix_solution": "处理上传异常", "prevention": "建议增加回归测试", "validation": "未提供", "keywords": ["upload"], "related_modules": [],
                "source_refs": [], "completeness": "incomplete", "gaps": ["根因待确认"], "human_notes": ""}

def test_incomplete_publish_duplicate_and_restart(tmp_path):
    collector = Collector()
    app = create_app(tmp_path, collector, Extractor())
    with TestClient(app) as client:
        result = client.post('/api/bug-review/import', json={"url": "https://github.com/demo/repo/pull/10"})
        assert result.status_code == 202
        review_id = result.json()['review']['id']
        url = '/api/bug-review/reviews/' + review_id
        review = client.get(url).json()['review']
        assert review['task']['status'] == 'completed'
        assert client.post('/api/bug-review/import', json={"url": "https://github.com/demo/repo/pull/10/files"}).json()['review']['id'] == review_id
        assert collector.calls == 1
        assert client.post(url + '/publish', json={"revision": review['revision']}).status_code == 409
        assert client.get('/api/bug-review/library?q=upload').json()['reviews'] == []
        approved = client.post(url + '/approve', json={"revision": review['revision'], "notes": "保留待确认说明"}).json()['review']
        assert client.post(url + '/publish', json={"revision": approved['revision']}).status_code == 200
        assert client.get('/api/bug-review/library?q=upload').json()['reviews'][0]['document']['completeness'] == 'incomplete'
    with TestClient(create_app(tmp_path, collector, Extractor())) as client:
        assert client.get('/api/bug-review/library?q=upload').json()['reviews'][0]['document']['gaps']

def test_regeneration_preserves_manual_and_published_snapshot(tmp_path):
    with TestClient(create_app(tmp_path, Collector(), Extractor())) as client:
        rid = client.post('/api/bug-review/import', json={'url': 'https://github.com/demo/repo/pull/11'}).json()['review']['id']
        url = '/api/bug-review/reviews/' + rid
        def act(operation, **body):
            current = client.get(url).json()['review']
            response = client.post(url + '/' + operation, json={'revision': current['revision'], **body})
            assert response.status_code in (200, 202), response.text
            return client.get(url).json()['review']
        doc = client.get(url).json()['review']['document']
        doc['title'] = '人工稿 upload'
        act('edit', document=doc)
        act('approve')
        act('publish')
        act('regenerate')
        assert client.get(url).json()['review']['document']['title'] == '人工稿 upload'
        assert client.get('/api/bug-review/library/' + rid).json()['review']['document']['title'] == '人工稿 upload'
        review = act('adopt')
        assert review['status'] == 'draft'
        assert client.post(url + '/publish', json={'revision': review['revision']}).status_code == 409
        assert client.get('/api/bug-review/library/' + rid).json()['review']['document']['title'] == '人工稿 upload'
        act('approve')
        act('publish')
        assert client.get('/api/bug-review/library/' + rid).json()['review']['document']['title'] == 'Upload error'
        assert any(item['action'] == 'edit' for item in client.get(url).json()['review']['history'])

def test_failed_model_keeps_material_and_source_cannot_be_invented(tmp_path):
    class BadExtractor:
        def generate(self, material):
            raise RuntimeError('secret-provider-response')
    with TestClient(create_app(tmp_path, Collector(), BadExtractor())) as client:
        rid = client.post('/api/bug-review/import', json={'url': 'https://github.com/demo/repo/pull/12'}).json()['review']['id']
        review = client.get('/api/bug-review/reviews/' + rid).json()['review']
        assert review['material']['sources']
        assert review['task']['status'] == 'failed'
        assert 'secret-provider-response' not in str(review)
    class Invented(Extractor):
        def generate(self, material):
            doc = super().generate(material)
            doc.update(completeness='complete', gaps=[])
            doc['root_cause'].update(basis='fact', source={'location': 'pr', 'snippet': 'Invented evidence'})
            return doc
    with TestClient(create_app(tmp_path, Collector(), Invented())) as client:
        review = client.post('/api/bug-review/import', json={'url': 'https://github.com/demo/repo/pull/13'}).json()['review']
        review = client.get('/api/bug-review/reviews/' + review['id']).json()['review']
        assert review['document']['root_cause']['source'] == {}
        assert review['document']['completeness'] == 'incomplete'

def test_concurrent_import_stale_write_and_interrupted_restart(tmp_path):
    from concurrent.futures import ThreadPoolExecutor
    app = create_app(tmp_path, Collector(), Extractor())
    with TestClient(app) as client:
        with ThreadPoolExecutor(max_workers=4) as pool:
            ids = list(pool.map(lambda _: client.post('/api/bug-review/import', json={'url': 'https://github.com/demo/repo/pull/14'}).json()['review']['id'], range(4)))
        assert len(set(ids)) == 1
        assert app.state.pipeline.collector.calls == 1
        rid = ids[0]
        review = client.get('/api/bug-review/reviews/' + rid).json()['review']
        assert client.post('/api/bug-review/reviews/' + rid + '/approve', json={'revision': 0}).status_code == 409
        app.state.pipeline.schedule(rid, 'regenerate', review['revision'])
    with TestClient(create_app(tmp_path, Collector(), Extractor())) as client:
        review = client.get('/api/bug-review/reviews/' + rid).json()['review']
        assert review['task']['error']['code'] == 'INTERRUPTED'
        assert review['document']['title'] == 'Upload error'


def test_publish_failure_does_not_index_unapproved_or_new_content(tmp_path):
    app = create_app(tmp_path, Collector(), Extractor())
    with TestClient(app) as client:
        rid = client.post('/api/bug-review/import', json={'url': 'https://github.com/demo/repo/pull/15'}).json()['review']['id']
        url = '/api/bug-review/reviews/' + rid
        review = client.get(url).json()['review']
        approved = client.post(url + '/approve', json={'revision': review['revision']}).json()['review']
        def fail_publish(**kwargs):
            raise OSError('disk full')
        app.state.pipeline.publisher.publish = fail_publish
        assert client.post(url + '/publish', json={'revision': approved['revision']}).status_code == 502
        assert client.get(url).json()['review']['status'] == 'approved'
        assert client.get('/api/bug-review/library?q=upload').json()['reviews'] == []

def test_refresh_keeps_draft_source_snapshot_and_human_corrections(tmp_path):
    class ChangingCollector(Collector):
        def collect(self, identity):
            material = super().collect(identity)
            material['gaps'] = []
            material['sources'][0]['text'] = 'Original cause' if self.calls == 1 else 'Updated discussion'
            return material
    class BoundExtractor(Extractor):
        def generate(self, material):
            doc = super().generate(material)
            doc.update(completeness='complete',gaps=[])
            doc['root_cause'].update(basis='fact',source={'location':'pr','snippet':'Original cause'})
            return doc
    with TestClient(create_app(tmp_path, ChangingCollector(), BoundExtractor())) as client:
        rid = client.post('/api/bug-review/import',json={'url':'https://github.com/demo/repo/pull/16'}).json()['review']['id']
        url = '/api/bug-review/reviews/' + rid
        original = client.get(url).json()['review']
        client.post(url+'/refresh',json={'revision':original['revision']})
        refreshed = client.get(url).json()['review']
        assert refreshed['material']['sources'][0]['text'] == 'Updated discussion'
        approved = client.post(url+'/approve',json={'revision':refreshed['revision']}).json()['review']
        assert approved['document']['root_cause']['source']['snippet'] == 'Original cause'
        doc = approved['document']
        doc['root_cause'].update(content='经审核补充根因',basis='human')
        doc['human_notes']='人工核对测试与修复过程'
        doc['gaps']=[]
        doc['completeness']='complete'
        edited = client.post(url+'/edit',json={'revision':approved['revision'],'document':doc}).json()['review']
        assert edited['document']['completeness'] == 'complete'

def test_edit_keeps_candidate_evidence_until_adopt(tmp_path):
    class BoundExtractor(Extractor):
        def generate(self, material):
            doc = super().generate(material)
            doc['root_cause']['source'] = {'location':'pr','snippet':'Handle upload'}
            return doc
    with TestClient(create_app(tmp_path,Collector(),BoundExtractor())) as client:
        rid = client.post('/api/bug-review/import',json={'url':'https://github.com/demo/repo/pull/17'}).json()['review']['id']
        url = '/api/bug-review/reviews/' + rid
        def act(op,**extra):
            review = client.get(url).json()['review']
            response = client.post(url+'/'+op,json={'revision':review['revision'],**extra})
            assert response.status_code in [200,202],response.text
            return client.get(url).json()['review']
        generated = act('regenerate')
        doc = generated['document']
        doc['title'] = 'Manual update'
        edited = act('edit',document=doc)
        assert edited['candidate_material']['sources'][0]['id'] == 'pr'
        adopted = act('adopt')
        assert adopted['document']['root_cause']['source']['source_id'] == 'pr'
