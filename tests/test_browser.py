"""Opt-in end-to-end smoke test with an installed Chromium or Chrome Headless Shell."""

import os
from threading import Thread

import pytest

from packet_explorer.server import Workspace, make_server


def check_plane_navigation(page, expect):
    page.get_by_role("button", name="Expand IOG 1", exact=True).click()
    expect(page.locator(".plane canvas:visible")).to_have_count(1)
    expect(page.locator("#iog")).to_have_value("0")
    canvas = page.get_by_label("IOG 1 detector map")
    canvas.scroll_into_view_if_needed()
    box = canvas.bounding_box()
    # IOG 1 has a 140 × 280 raster. The fixture's chip 11/channel 0 is
    # column 3, row 68 of its upper-left tile.
    pitch = min((box["width"] - 6) / 140, (box["height"] - 6) / 280)
    x = box["x"] + box["width"] / 2 + (3.5 - 70) * pitch
    y = box["y"] + box["height"] / 2 + (68.5 - 140) * pitch
    page.mouse.move(x, y)
    readout = page.locator("#pixelReadout")
    expect(readout).to_contain_text("IOG 1 · Tile 1 · Chip 11 · Channel 0")
    page.mouse.wheel(0, -400)
    expect(page.locator(".plane:visible .zoom-value")).to_have_text("2.7×")
    expect(readout).to_contain_text("Chip 11 · Channel 0")
    page.mouse.down()
    page.mouse.move(x - 18, y + 8, steps=4)
    page.mouse.up()
    expect(readout).to_contain_text("Chip 11 · Channel 0")
    assert not page.locator("#inspect").evaluate("el => el.open")
    page.mouse.click(x - 18, y + 8)
    expect(page.locator("#tbody tr")).to_have_count(2)
    page.locator("#inspect summary").click()
    page.locator("#mapFit").click()
    expect(page.locator(".plane:visible .zoom-value")).to_have_text("")
    page.locator("#mapFill").click()
    expect(page.locator(".plane:visible .zoom-value")).not_to_have_text("")
    page.get_by_role("button", name="Show all planes").click()
    expect(page.locator(".plane canvas:visible")).to_have_count(8)


def check_histogram(page, expect):
    summary = page.locator("#histSummary")
    page.locator("#histogram summary").click()
    expect(summary).to_have_text("4 packets · Mean 12")
    page.locator("#histFit").check()
    plot = page.locator("#histPlot")
    plot.scroll_into_view_if_needed()
    r = plot.bounding_box()
    # Codes 8 and 16 plus one empty bin at either end give codes 7–17.
    page.mouse.move(r["x"] + 58 + 1.5 * (r["width"] - 74) / 11, r["y"] + 50)
    expect(page.locator("#tooltip")).to_contain_text("ADC dataword 8")
    expect(page.locator("#tooltip")).to_contain_text("2 packets")
    page.locator("#histArea").select_option("1/2")
    expect(summary).to_have_text("0 packets in this window")
    page.locator("#histArea").select_option("1/1")
    expect(summary).to_have_text("2 packets · Mean 12")
    page.locator("#histField").select_option("local_fifo")
    expect(summary).to_have_text("2 packets · Mean 1.5")
    page.get_by_role("button", name="Expand IOG 1", exact=True).click()
    page.locator("#drawRegion").click()
    canvas = page.get_by_label("IOG 1 detector map")
    canvas.scroll_into_view_if_needed()
    box = canvas.bounding_box()
    pitch = min((box["width"] - 6) / 140, (box["height"] - 6) / 280)
    cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    # Cross the top-left and top-right tiles, including the fixture pixel.
    page.mouse.move(cx - 68 * pitch, cy - 85 * pitch)
    page.mouse.down()
    page.mouse.move(cx + 5 * pitch, cy - 70 * pitch, steps=4)
    page.mouse.up()
    expect(page.locator("#histArea")).to_have_value("drawn")
    expect(summary).to_have_text("2 packets · Mean 1.5")
    page.locator("#histSamples").select_option("pixels")
    expect(summary).to_have_text("1 pixel · Mean 1")
    page.locator("#field").select_option("adc")
    page.locator("#stat").select_option("median")
    expect(summary).to_have_text("1 pixel · Mean 12")
    page.locator("#hold").fill("10")
    page.locator("#hold").press("Tab")
    page.get_by_role("button", name="Step forward", exact=True).click()
    expect(summary).to_have_text("0 pixels in this window")
    page.locator("#histSamples").select_option("packets")
    expect(summary).to_have_text("0 packets in this window")
    page.get_by_role("button", name="Step backward", exact=True).click()
    expect(summary).to_have_text("2 packets · Mean 1.5")
    page.locator("#histogram summary").click()
    page.locator("#hold").fill("0")
    page.locator("#hold").press("Tab")
    page.locator("#field").select_option("occupancy")
    page.get_by_role("button", name="Show all planes").click()
    assert not page.locator("#inspect").evaluate("el => el.open")


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
            check_histogram(page, pw.expect)
            check_plane_navigation(page, pw.expect)
            page.get_by_label("Theme", exact=True).select_option("dark")
            pw.expect(page.locator("html")).to_have_attribute("data-theme", "dark")
            page.locator("#iog").select_option("1")
            page.locator("#field").select_option("adc")
            page.locator("#stat").select_option("median")
            pw.expect(page.locator("#mapSummary")).to_contain_text("2 packets")
            legend = page.locator("#legend")
            pw.expect(legend).to_contain_text("255 ADC")
            page.locator("#scale").select_option("window")
            pw.expect(legend).to_have_text("12 ADC")
            page.locator("#scale").select_option("custom")
            page.locator("#scaleMin").fill("9")
            page.locator("#scaleMax").fill("13")
            pw.expect(legend).to_contain_text("13 ADC")
            page.locator("#scaleMax").fill("8")
            assert not page.locator("#scaleMax").evaluate("el => el.validity.valid")
            pw.expect(legend).to_contain_text("13 ADC")
            page.locator("#scaleMax").fill("13")
            page.locator("#scale").select_option("window")
            page.locator("#hold").fill("100")
            page.locator("#hold").press("Tab")
            page.get_by_role("button", name="Step forward", exact=True).click()
            pw.expect(page.locator("#mapSummary")).to_have_text(
                "0 packets · 0 active pixels · 1 held"
            )
            pw.expect(legend).to_contain_text("No active values")
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
            page.reload()
            pw.expect(page.locator("#theme")).to_have_value("dark")
            pw.expect(page.locator("html")).to_have_attribute("data-theme", "dark")
            assert not errors
            browser.close()
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
        work.close()
