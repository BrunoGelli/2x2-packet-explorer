"""Opt-in end-to-end smoke test with an installed Chromium or Chrome Headless Shell."""

import os
from threading import Thread

import pytest

from packet_explorer.server import Workspace, make_server


@pytest.mark.skipif(
    not os.environ.get("PACKET_EXPLORER_BROWSER"),
    reason="Set PACKET_EXPLORER_BROWSER to a Chromium executable.",
)
def test_browser_packet_playback(packet_file, tmp_path):
    pw = pytest.importorskip("playwright.sync_api")
    work = Workspace(tmp_path, tmp_path / "cache")
    server = make_server(work, 0)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with pw.sync_playwright() as playwright:
            browser = playwright.chromium.launch(
                executable_path=os.environ["PACKET_EXPLORER_BROWSER"]
            )
            page = browser.new_page(viewport={"width": 1320, "height": 980})
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto(f"http://127.0.0.1:{server.server_port}/#key={work.access_key}")
            page.get_by_label(packet_file.name, exact=False).check()
            page.get_by_text("Open selection", exact=True).click()
            pw.expect(page.locator("#tick")).to_have_value("2")
            page.get_by_role("button", name="Single tick").click()
            page.get_by_role("button", name="Step forward", exact=True).click()
            pw.expect(page.locator("#tick")).to_have_value("3")
            pw.expect(page.locator("#mapSummary")).to_contain_text("4 packets")
            page.locator("#iog").select_option("1")
            page.locator("#field").select_option("adc")
            page.locator("#stat").select_option("median")
            pw.expect(page.locator("#mapSummary")).to_contain_text("2 packets")
            page.locator("#hold").fill("100")
            page.locator("#hold").press("Tab")
            page.get_by_role("button", name="Step forward", exact=True).click()
            pw.expect(page.locator("#mapSummary")).to_have_text(
                "0 packets · 0 active pixels · 1 held"
            )
            page.get_by_role("button", name="Step backward", exact=True).click()
            pw.expect(page.locator("#tick")).to_have_value("3")
            page.locator("#inspect summary").click()
            pw.expect(page.locator("#tbody tr")).to_have_count(2)
            page.locator("#tbody tr").first.click()
            pw.expect(page.locator("#rowDetail")).to_contain_text("dataword = 8")
            page.get_by_text("Source rows", exact=True).click()
            page.locator("#rawStart").fill("4")
            page.locator("#rawStart").press("Tab")
            pw.expect(page.locator("#tbody tr td").first).to_have_text("4")
            assert not errors
            browser.close()
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
        work.close()
