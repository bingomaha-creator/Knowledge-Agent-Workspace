"""最新前端 UI 验收（Playwright 真实浏览器）。

前置条件：本地已启动
  - 后端  http://127.0.0.1:8000  （uvicorn backend.app.main:app，预算上限由 RUN_MAX_* 环境变量控制）
  - 前端  http://127.0.0.1:5173  （npm run dev，直连后端 API）

执行：python tests/acceptance/browser_acceptance.py
产物：data/acceptance/ui/*.png（截图）+ stdout JSON 摘要
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from playwright.sync_api import Error as PlaywrightError, sync_playwright

FRONTEND = "http://127.0.0.1:5173/"
OUT = Path("data/acceptance/ui")
OUT.mkdir(parents=True, exist_ok=True)

QUESTION = "Tavily Search 是什么？请基于当前网页资料给出简短、有引用的说明。"
RUN_TIMEOUT_SECONDS = 360


def shot(page: Page, name: str) -> None:
    page.screenshot(path=OUT / name, full_page=False)
    print(f"[ui] screenshot saved: {OUT / name}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--skip-run", action="store_true", help="跳过真实 Run（免预算复验 UI 结构）")
    args = parser.parse_args()
    results: dict = {}
    with sync_playwright() as pw:
        try:
            browser = pw.chromium.launch(channel="msedge")
            results["browser"] = "msedge"
        except PlaywrightError:
            browser = pw.chromium.launch()
            results["browser"] = "chromium"
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.set_default_timeout(30_000)

        # 1) 页面加载与品牌/导航；存在活跃会话时应用会自动选中并直接进入聊天页，
        #    因此“空态”与“聊天页”二者出现其一即视为首页渲染正常。
        page.goto(FRONTEND, wait_until="networkidle")
        results["brand"] = page.get_by_text("Hermes Research").first.is_visible()
        empty_chat = page.get_by_text("开始一项可信研究").is_visible()
        page.get_by_placeholder("提出一个需要证据支持的问题…").wait_for(state="visible", timeout=15_000)
        composer_visible = page.get_by_placeholder("提出一个需要证据支持的问题…").is_visible()
        results["empty_chat"] = empty_chat
        results["home_chat_or_empty"] = empty_chat or composer_visible
        results["nav"] = page.get_by_text("◇ Memory").is_visible() and page.get_by_text("△ Skills").is_visible() and page.get_by_text("○ 系统状态").is_visible()
        shot(page, "01_home.png")
        print("[ui] home loaded:", {k: results[k] for k in ("brand", "empty_chat", "home_chat_or_empty", "nav")})

        # 2) 新建会话
        page.get_by_role("button", name="新建会话").click()
        page.get_by_placeholder("提出一个需要证据支持的问题…").wait_for(state="visible")
        results["new_session"] = page.get_by_role("heading", name="新会话").count() > 0 or page.get_by_placeholder("提出一个需要证据支持的问题…").is_visible()
        shot(page, "02_new_session.png")
        print("[ui] new session:", results["new_session"])

        if args.skip_run:
            results["run_terminal"] = "skipped"
            results["report_rendered"] = "skipped"
            results["verification_text"] = "skipped"
            results["status_page"] = True
            page.get_by_text("○ 系统状态").click()
            page.wait_for_timeout(1500)
            status_text = page.locator("body").inner_text()
            results["status_page"] = "系统状态" in status_text and ("healthy" in status_text or "健康" in status_text)
            shot(page, "04_status.png")
            print("[ui] skipped real run; status page:", results["status_page"])
        else:
            # 3) 切换到联网搜索并发送问题
            page.locator("label", has_text="联网搜索").click()
            time.sleep(0.3)
            page.locator("textarea").fill(QUESTION)
            page.get_by_role("button", name="发送研究 →").click()
            print(f"[ui] submitted question, waiting up to {RUN_TIMEOUT_SECONDS}s for run…")
            deadline = time.monotonic() + RUN_TIMEOUT_SECONDS
            terminal_seen = False
            while time.monotonic() < deadline:
                # 终态标志：报告渲染出“证据引用”且验证徽标行出现（✓ = passed，! = failed）
                if page.locator(".verification-row").count() and "证据引用" in page.locator(".report-view").inner_text():
                    terminal_seen = True
                    break
                time.sleep(1.0)
            results["run_terminal"] = terminal_seen
            shot(page, "03_run_done.png")
            print("[ui] run terminal:", terminal_seen)

            # 4) 报告与验证徽标
            verification = page.locator(".verification-row")
            results["verification_row"] = verification.count() > 0
            results["verification_text"] = verification.inner_text() if verification.count() else ""
            report_text = page.locator(".report-view").inner_text() if page.locator(".report-view").count() else ""
            results["report_rendered"] = "证据引用" in report_text
            results["report_len"] = len(report_text)
            results["citations"] = [t for t in report_text.splitlines() if t.strip().startswith("[ev_")]
            print("[ui] report:", {k: results[k] for k in ("report_rendered", "report_len")})
            print("[ui] verification:", results["verification_text"])

            # 5) 系统状态页
            page.get_by_text("○ 系统状态").click()
            page.wait_for_timeout(1500)
            status_text = page.locator("body").inner_text()
            results["status_page"] = "系统状态" in status_text and ("healthy" in status_text or "健康" in status_text)
            shot(page, "04_status.png")
            print("[ui] status page:", results["status_page"])

        browser.close()

    structural = all([
        results["brand"], results["home_chat_or_empty"], results["nav"], results["new_session"], results["status_page"],
    ])
    run_part = args.skip_run or (results["run_terminal"] is True and results["report_rendered"] is True)
    passed = structural and run_part
    print(json.dumps(results, ensure_ascii=False, indent=2))
    print(f"RESULT: {'PASS' if passed else 'FAIL'}")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
