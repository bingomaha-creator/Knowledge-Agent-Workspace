import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from fastapi.testclient import TestClient
from bug_review.api import create_app
from bug_review.extraction import QwenExtractor
from test_api import Collector

def test_existing_qwen_configuration_uses_real_http_schema_and_source_binding(tmp_path, monkeypatch):
    captured = []
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            captured.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
            body = {'title':'Upload error','symptom':'上传异常','root_cause':{'content':'待确认','source':{'type':'pr_comment','location':'pr','snippet':'Handle upload'}},'basis':'inference','impact':{'scope':'upload','severity':'P2'},'fix_solution':'处理上传错误','prevention':'建议增加测试','completeness':'incomplete','gaps':['缺少根因'],'keywords':['upload']}
            self.send_response(200)
            self.send_header('Content-Type','application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'choices':[{'message':{'content':json.dumps(body,ensure_ascii=False)}}]}).encode())
        def log_message(self,*args):
            pass
    server = ThreadingHTTPServer(('127.0.0.1',0),Handler)
    thread = Thread(target=server.serve_forever,daemon=True)
    thread.start()
    try:
        monkeypatch.setenv('QWEN_API_KEY','fake-local-key')
        monkeypatch.setenv('QWEN_BASE_URL',f'http://127.0.0.1:{server.server_port}/v1')
        monkeypatch.setenv('QWEN_MODEL','qwen-test')
        with TestClient(create_app(tmp_path,Collector(),QwenExtractor())) as client:
            review = client.post('/api/bug-review/import',json={'url':'https://github.com/a/b/pull/1'}).json()['review']
            review = client.get('/api/bug-review/reviews/'+review['id']).json()['review']
            assert review['task']['status'] == 'completed',review['task']
            assert review['document']['root_cause']['source']['source_id'] == 'pr'
            assert captured[0]['model'] == 'qwen-test'
            assert 'fake-local-key' not in str(captured[0])
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
