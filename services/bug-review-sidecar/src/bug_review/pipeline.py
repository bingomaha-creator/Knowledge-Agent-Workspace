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
                document = self.validate_document(document, material)
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

    def validate_document(self, document, material, human=False):
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
        if not isinstance(impact, dict) or not isinstance(impact.get('scope'), str) or impact.get('severity') not in ['P0', 'P1', 'P2', 'P3']:
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
        sources = {x['id']: x for x in (material or {}).get('sources', [])}
        gaps = list((material or {}).get('gaps', [])) + list((material or {}).get('model_gaps', [])) + doc['gaps']
        def bind(ref):
            if not isinstance(ref, dict):
                raise ReviewError('INVALID_DOCUMENT', '来源格式错误。', 422)
            sid, snippet = ref.get('location'), ref.get('snippet')
            if sid in sources and isinstance(snippet, str) and snippet.strip() and snippet.replace('\r\n', '\n') in sources[sid]['text'].replace('\r\n', '\n'):
                return {**ref, 'source_id': sid, 'url': sources[sid]['url'], 'type': sources[sid]['type']}
            return None
        root_ref = bind(root.get('source') or {})
        root['source'] = root_ref or {}
        refs = [bind(ref) for ref in doc['source_refs']]
        if any(ref is None for ref in refs):
            gaps.append('生成或提交的部分来源无法与原文绑定，已移除。')
        doc['source_refs'] = [ref for ref in refs if ref]
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
