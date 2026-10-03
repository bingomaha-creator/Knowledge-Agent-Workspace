from pathlib import Path
from fastapi import BackgroundTasks, FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from .github import GitHubCollector, ReviewError
from .extraction import QwenExtractor
from .pipeline import Pipeline

class ImportRequest(BaseModel):
    url: str = Field(min_length=1, max_length=2000)

class ActionRequest(BaseModel):
    revision: int = Field(ge=0)
    document: dict | None = None
    notes: str = Field(default='', max_length=10000)

def create_app(data_dir, collector=None, extractor=None):
    import os
    pipeline = Pipeline(data_dir, collector or GitHubCollector(os.getenv('GITHUB_TOKEN') or os.getenv('GH_TOKEN', '')), extractor or QwenExtractor())
    app = FastAPI(title='Bug Review Sidecar')
    app.state.pipeline = pipeline

    @app.exception_handler(ReviewError)
    async def business_error(_request: Request, error: ReviewError):
        return JSONResponse(status_code=error.status, content={'code': error.code, 'error': error.message})

    @app.get('/api/bug-review/health')
    def health():
        return {'status': 'ok', 'retrieval': 'bm25', 'model': bool(os.getenv('QWEN_API_KEY')), 'github_token': bool(os.getenv('GITHUB_TOKEN') or os.getenv('GH_TOKEN'))}

    @app.get('/api/bug-review/reviews')
    def reviews():
        return {'reviews': [{k: r[k] for k in ['id', 'identity', 'revision', 'status', 'task', 'updated_at']} | {'title': (r['document'] or {}).get('title', r['identity']['url'])} for r in pipeline.all()]}

    @app.post('/api/bug-review/import', status_code=202)
    def import_pr(body: ImportRequest, tasks: BackgroundTasks):
        review, created = pipeline.import_pr(body.url)
        if created:
            tasks.add_task(pipeline.run, review['id'])
        return {'review': review, 'existing': not created}

    @app.get('/api/bug-review/library')
    def library(q: str = ''):
        return {'reviews': pipeline.library(q[:1000])}

    @app.get('/api/bug-review/library/{review_id}')
    def published(review_id: str):
        review = pipeline.get(review_id)
        if not review.get('published'):
            raise ReviewError('NOT_PUBLISHED', '案例尚未发布。', 404)
        return {'review': {'id': review_id, 'identity': review['identity'], **review['published']}}

    @app.get('/api/bug-review/reviews/{review_id}')
    def get_review(review_id: str):
        return {'review': pipeline.get(review_id)}

    @app.post('/api/bug-review/reviews/{review_id}/{operation}')
    def action(review_id: str, operation: str, body: ActionRequest, tasks: BackgroundTasks):
        if operation in ['retry', 'refresh', 'regenerate']:
            mode = 'import' if operation == 'retry' else operation
            review = pipeline.schedule(review_id, mode, body.revision)
            tasks.add_task(pipeline.run, review_id)
            return JSONResponse(status_code=202, content={'review': review})
        return {'review': pipeline.act(review_id, operation, body.revision, body.document, body.notes)}
    return app

# uvicorn --factory bug_review.api:configured_app, env injected by the launcher.
def configured_app():
    import os
    return create_app(Path(os.getenv('BUG_REVIEW_DATA_DIR', 'data')))
