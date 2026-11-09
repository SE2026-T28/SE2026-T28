"""Regenerate the individual VT-114 report PDF with ReportLab."""
from __future__ import annotations

from html import escape
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    HRFlowable,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

ROOT = Path(__file__).resolve().parents[2]
DOCS = Path(__file__).resolve().parent
OUTPUT = ROOT / "BT3_24002070_VT-114.pdf"
pdfmetrics.registerFont(TTFont("DejaVu", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"))
pdfmetrics.registerFont(TTFont("DejaVu-Bold", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"))

NAVY = colors.HexColor("#15324A")
TEAL = colors.HexColor("#0B6A73")
LIGHT = colors.HexColor("#EAF2F4")
GRAY = colors.HexColor("#4D5962")

styles = {
    "title": ParagraphStyle("title", fontName="DejaVu-Bold", fontSize=16, leading=20, textColor=NAVY, spaceAfter=8),
    "subtitle": ParagraphStyle("subtitle", fontName="DejaVu", fontSize=9.4, leading=13, textColor=GRAY, spaceAfter=7),
    "h1": ParagraphStyle("h1", fontName="DejaVu-Bold", fontSize=11.5, leading=15, textColor=NAVY, spaceBefore=7, spaceAfter=4, keepWithNext=True),
    "h2": ParagraphStyle("h2", fontName="DejaVu-Bold", fontSize=10, leading=13.5, textColor=TEAL, spaceBefore=7, spaceAfter=4),
    "body": ParagraphStyle("body", fontName="DejaVu", fontSize=9, leading=12.3, spaceAfter=4),
    "small": ParagraphStyle("small", fontName="DejaVu", fontSize=8.2, leading=11, spaceAfter=3),
    "tiny": ParagraphStyle("tiny", fontName="DejaVu", fontSize=7.5, leading=10.4),
    "tablehead": ParagraphStyle("tablehead", fontName="DejaVu-Bold", fontSize=7.8, leading=10.4, textColor=colors.white),
    "callout": ParagraphStyle("callout", fontName="DejaVu-Bold", fontSize=8.8, leading=12, textColor=NAVY, spaceAfter=4),
}


def p(text: str, kind: str = "body") -> Paragraph:
    return Paragraph(text, styles[kind])


def section(title: str) -> list:
    return [p(title, "h1")]


def table(headers: list[str], rows: list[list[str]], widths: list[float], tiny: bool = False) -> Table:
    cell_style = "tiny" if tiny else "small"
    data = [[p(escape(x), "tablehead") for x in headers]]
    data += [[p(x, cell_style) for x in row] for row in rows]
    t = Table(data, colWidths=widths, repeatRows=1, hAlign="LEFT")
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), NAVY),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, LIGHT]),
        ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#C9D8DC")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))
    return t


def bullets(items: list[str], kind: str = "body") -> list[Paragraph]:
    return [p("• " + item, kind) for item in items]


story: list = []

# Main content — sections flow naturally across A4 pages.
story += [p("BÀI TẬP CÁ NHÂN 3 · APP-04 · VT-114", "title")]
story += [p("Đặng Minh Quang · MSSV 24002070 · SE2026-T28 · Thành viên · Kiểm tra repo: 08/11/2026", "subtitle")]
story += [p("Repository: <link href='https://github.com/SE2026-T28/SE2026-T28'>github.com/SE2026-T28/SE2026-T28</link> · Draft PR: <link href='https://github.com/SE2026-T28/SE2026-T28/pull/19'>#19</link> · Baseline <b>4c8e96e4c8eadb934be30a8efc220fa93919b60a</b>", "small")]
story += [p("<b>Cam kết:</b> Tôi chịu trách nhiệm về toàn bộ code, test và nội dung bài làm; tôi đã khai báo việc sử dụng AI.", "small")]
story += section("1. Specification và invariant")
story += [p("<b>Problem statement.</b> APP-04 chưa có task/status API. Tác vụ kéo dài cần trả phản hồi nhanh, tiếp tục bất đồng bộ và cho người dùng xem tiến trình; retry không được tạo task hoặc tác động hoàn tất trùng. Slice dùng một tác vụ demo độc lập với OIDC/Registration.")]
story += bullets([
    "<b>AC1:</b> POST /api/demo-tasks có Idempotency-Key và workUnits 1–5 trả 202, task ID, statusUrl trước khi hoàn tất.",
    "<b>AC2:</b> GET status trả queued/running/succeeded/failed, progress 0–100 không giảm; trang demo hiển thị tiến trình.",
    "<b>AC3:</b> cùng key + payload, kể cả retry đồng thời, trả cùng ID; completion callback tối đa một lần trong một process.",
    "<b>AC4:</b> cùng key + payload khác trả 409; key/input sai trả 400; task failed giữ failed khi retry cùng key.",
])
story += [p("<b>Ràng buộc:</b> kiểm 200 tác vụ đồng thời, p95 phản hồi 202 và hoàn tất demo ≤5,0 giây trên máy đo; không log key, mật khẩu hay body. Store in-memory chỉ là prototype. <b>Invariant:</b> mỗi key được giữ ánh xạ đúng một payload chuẩn hóa → một task ID → tối đa một callback hoàn tất.")]
story += section("2. AI-assisted plan trước code")
story += [p("<b>Prompt chính:</b> “Ở baseline 4c8e96e, lập plan test-first cho tác vụ dài bất đồng bộ, progress, retry không trùng; nêu API, pairwise, 200 tải, mutation &gt;→&gt;=, file sửa. Chưa code; giữ contract OIDC/Registration.”")]
story += [p("<b>Output AI ban đầu:</b> chuyển POST /api/users/register thành job Redis; thêm tiến trình vào React OIDC dashboard; test retry/tải/mutation. <b>Review repo:</b> bác bỏ chuyển Registration vì A1 đang trả 201/409 và email có unique index PostgreSQL; bác bỏ Redis vì package.json không có queue/Redis. Sửa thêm: React callback còn placeholder trên baseline nên dùng trang demo same-origin; thay sleep cố định bằng polling deadline.")]
story += [p("<b>Assumptions/file plan:</b> demo không ghi giao dịch/thông báo thật; task có 1–5 bước, failAt phục vụ test. Sửa app.ts, thêm tasks/store.ts, tasks/routes.ts, async-tasks.test.ts, load/browser harness và README. Không đổi Prisma schema, Registration hoặc client-demo.", "small")]

# Strategy and test cases.
story += section("3. Test strategy dựa trên risk")
story += [p("<b>Unit:</b> state transition, key→ID, callback một lần, failure. <b>Integration/API:</b> HTTP 202/400/409/404, progress, concurrent retries. <b>E2E:</b> Chrome headless bấm form thật và thấy 100%. Không lặp lại test OIDC Discovery, Argon2 hay Prisma unique: các suite hiện có sở hữu hợp đồng đó.")]
cases = [
    ["T01", "AC1", "API", "key mới; 3 bước", "202 + ID/statusUrl", "P0"],
    ["T02", "AC2", "API", "poll T01", "tiến trình không giảm; 100%", "P0"],
    ["T03/3b", "AC3 / retry", "API+unit", "20 request cùng key", "một ID; callback 1 lần", "P0"],
    ["T04", "AC4 / conflict", "API", "cùng key; 3 rồi 5 bước", "409; task cũ giữ nguyên", "P0"],
    ["T05", "AC4 / negative", "API", "thiếu/short key", "400; không tạo task", "P0"],
    ["T06", "biên/mutation", "API", "workUnits=5", "202; mutant bị bắt", "P0"],
    ["T07", "input negative", "API", "workUnits=0 hoặc 6", "400", "P1"],
    ["T08/8b/8c", "failure path", "API+unit", "failAt=2; callback throw", "failed; retry không gọi lại", "P0"],
    ["T09", "unknown ID", "API", "UUID chưa tồn tại", "404", "P1"],
    ["T10", "progress UI", "HTTP/E2E", "mở /demo-tasks", "script/progress; browser 100%", "P1"],
    ["T11", "pairwise", "API", "9 tổ hợp hợp lệ", "status/retry theo kỳ vọng", "P1"],
    ["T12", "200 tasks", "load", "200 key riêng; 5 bước", "p95 ≤5s trong harness", "P0"],
]
story += [table(["ID", "Risk/AC", "Level", "Precondition/input", "Expected", "Ưu tiên"], cases, [57, 68, 56, 129, 146, 45], tiny=True)]
story += [Spacer(1, 7), p("<b>Negative/failure:</b> T05/T07 là negative input; T04 là conflict; T08 và T08c tiêm lỗi giữa tác vụ/callback. T03b đo tác động hoàn tất một lần thay vì chỉ so ID.", "small")]

# Pairwise and test first.
story += section("4. Pairwise/combinatorial và test-first")
story += [p("Ba trục: workUnits {2,3,5}, outcome {success, fail-first, fail-last}, retry {none, during, after}. Toàn bộ 3³ = 27 bộ; chín hàng dưới là ma trận Latin: mỗi cặp giá trị giữa hai trục xuất hiện đúng một lần. Chọn workUnits ≥2 để fail-first/fail-last là hai input khác nhau; biên dưới 1 và input sai 0/6 có test riêng.")]
pair_rows = [
    ["P01", "2", "success", "none"], ["P02", "2", "fail-first", "during"], ["P03", "2", "fail-last", "after"],
    ["P04", "3", "success", "during"], ["P05", "3", "fail-first", "after"], ["P06", "3", "fail-last", "none"],
    ["P07", "5", "success", "after"], ["P08", "5", "fail-first", "none"], ["P09", "5", "fail-last", "during"],
]
story += [table(["Case", "Bước", "Kết quả", "Thời điểm retry"], pair_rows, [75, 72, 150, 204], tiny=False)]
story += [Spacer(1, 8)]
story += [p("<b>AI sinh test:</b> đã xóa case “GET status hai lần đều 200” vì trùng T02 mà không kiểm chuyển trạng thái; sửa case “sleep đúng 100ms rồi expect success” thành polling có deadline 3 giây, kiểm terminal và progress không giảm.")]
story += [p("<b>Red trước code:</b> nhánh từ baseline <b>4c8e96e</b>; plan <b>a8b4e4a</b>, spec <b>fed674d</b>, test-only commit <b>3f4eb50</b>. Chạy `node --test --test-name-pattern='T01/T02' dist/test/async-tasks.test.js`: mong 202, thực tế <b>404</b> (red.log). Đây là fail đúng lý do endpoint chưa có, không phải fail compile.")]
story += [p("<b>AI-assisted patch:</b> commit <b>eddf66f</b> thêm TaskStore, route, trang tiến trình. Review diff phát hiện union TypeScript chưa narrow và script UI một dòng khó đọc; đã sửa trước chấp nhận. Test slice cuối <b>12/12 pass</b> (pass.log); full suite sạch với PostgreSQL `app04_test` <b>25/25 pass, 0 skip</b> (full-suite.log).")]
story += [p("<b>Contract HTTP:</b> POST JSON workUnits 1–5, failAt tùy chọn, Idempotency-Key 8–64 ký tự; GET /api/demo-tasks/:id. Retry cùng payload trả 202 cùng ID; payload khác 409. Demo page ở /demo-tasks. State được gán vào map trước khi chạy microtask.", "small")]

# Mutation, coverage, flakes, and load.
story += section("5. Who tests the tests?")
story += [p("<b>Mutation bắt buộc:</b> nhánh tạm local `experiment/vt114-boundary-mutation`, commit <b>23e0080</b>, đổi điều kiện `workUnits &gt; 5` thành `workUnits &gt;= 5` trong tasks/routes.ts. T06 gửi 5 bước: mutant trả <b>400</b> thay vì <b>202</b> và fail (mutation.log). Nhánh nộp giữ `&gt;`; T06 pass lại. Không đưa mutation vào PR #19.")]
story += [p("<b>Coverage của slice (Node built-in):</b> tasks/routes.js 98,67% line / 85,71% branch; tasks/store.js 100% line / 92,59% branch. Nhánh capacity 10.000 task và vài input sai chưa được chạy. Risk coverage: AC1 T01+load; AC2 T02/T09/T10+Chrome; AC3 T03/T03b+pairwise; AC4 T04–T08c+pairwise. Coverage toàn repo 75% line/78,57% branch trong run slice gồm nhiều module không liên quan, nên không dùng nó làm kết luận chất lượng.")]
story += [p("<b>Flaky risk 1 — time:</b> test poll đến terminal với deadline thay vì assert sau đúng một sleep; load ghi p95 thực đo. <b>Flaky risk 2 — order/shared state:</b> key cố định nhưng riêng từng case, store riêng cho test file; so UUID theo quan hệ, không đoán giá trị. Khi đổi nhánh, `dist` còn test M2 cũ gây 3 lỗi giả; sau dọn output sinh ra, full suite sạch 25/25 (stale-dist.log vs full-suite.log).")]
story += section("6. Tải 200 tác vụ và giới hạn kết luận")
story += [table(["Phép đo", "Kết quả", "Mục tiêu", "Kết luận"], [
    ["200 POST đồng thời", "p95 ack 350,74 ms", "≤5.000 ms", "đạt trong harness"],
    ["200 task, 5 bước × 40 ms", "p95 hoàn tất 556,42 ms", "≤5.000 ms", "đạt trong harness"],
    ["Chrome headless", "succeeded — 100%", "hiện tiến trình", "đạt happy path"],
], [157, 120, 95, 129])]
story += [Spacer(1, 6), p("Harness chạy Node 24.22.0, HTTP loopback, một process, 200 key khác nhau; không có PostgreSQL write, browser đồng thời, email thật hoặc mạng ngoài. Kết quả không chứng minh throughput production hay chống trùng qua restart. Retry cùng key được kiểm riêng ở T03/T11.")]

# Traceability and review.
story += section("7. Traceability và engineering evidence")
trace = [
    ["AC1 / ack", "T01, T12", "test/async-tasks.test.ts; scripts/load-tasks.mjs", "3f4eb50 → eddf66f; PR #19", "red 404; pass; p95 350,74 ms"],
    ["AC2 / progress", "T02, T09, T10, Chrome", "test/async-tasks.test.ts; scripts/browser-demo.mjs", "eddf66f; PR #19", "terminal 100%; browser pass"],
    ["AC3 / duplicate", "T03, T03b, T11", "test/async-tasks.test.ts; tasks/store.ts", "eddf66f; PR #19", "1 ID; callback 1 lần"],
    ["AC4 / error", "T04–T08c", "test/async-tasks.test.ts; tasks/routes.ts", "d9bb699; PR #19", "400/409; failed giữ nguyên"],
    ["Boundary risk", "T06", "tasks/routes.ts; mutation.log", "23e0080 tạm; PR #19 sạch", "mutant 400 vs 202"],
]
story += [table(["AC/risk", "Test", "File", "Commit/PR", "Kết quả"], trace, [83, 78, 168, 110, 62], tiny=True)]
story += [Spacer(1, 9)]
story += [p("<b>Bằng chứng:</b> docs/bt3-vt114/{plan.md,spec.md,README.md,red.log,pass.log,mutation.log,coverage.log,full-suite.log,headers.log,load.json,browser.json,review.md,ai-usage.md}. Nhánh nộp `feat/bt3-vt114-async-tasks`; <link href='https://github.com/SE2026-T28/SE2026-T28/pull/19'>Draft PR #19</link> chưa merge.")]
story += [p("<b>Hai đề xuất AI có vẻ hợp lý nhưng không đủ tin:</b> (1) `Map` ngăn retry trùng trong process, không bảo đảm sau restart hoặc nhiều instance; (2) callback tối đa một lần không bảo đảm exactly-once đối với dịch vụ ngoài có thể thực hiện xong rồi báo lỗi. Cần unique key bền vững, outbox và downstream idempotency trước khi dùng cho giao dịch/thông báo thật.")]
story += [p("<b>Review kết quả:</b> invariant được bảo vệ trong phạm vi process; không sửa Registration/OIDC. Tồn tại: endpoint demo chưa xác thực người dùng/tenant, state mất khi restart, cap 10.000 record làm 503 thay vì evict và tái chạy. PR giữ Draft để nhóm review; test tiếp theo nên kiểm worker crash giữa DB write và thông báo.")]

# Reflection.
story += section("8. Reflection (337 từ)")
reflection = DOCS.joinpath("reflection.md").read_text(encoding="utf8").split("\n", 2)[-1].strip().split("\n\n")
for paragraph in reflection:
    story += [p(escape(paragraph))]
story += [Spacer(1, 18), HRFlowable(width="100%", thickness=0.5, color=colors.HexColor("#B6C7CB")), Spacer(1, 9)]
story += [p("Bằng chứng chi tiết và giới hạn của kết quả đo được ghi ở phụ lục và README trên branch.", "small")]
story += [PageBreak()]

# Appendix A — AI usage (excluded from main-page limit).
story += [p("PHỤ LỤC A · AI Usage Log", "title")]
story += [p("Công cụ: OpenAI Codex trong workspace. Người chịu trách nhiệm: Đặng Minh Quang.")]
story += bullets([
    "<b>Prompt plan:</b> lập plan test-first VT-114 trên baseline 4c8e96e, gồm API, pairwise, 200 task, mutation, file sửa; chưa code. Output AI: chuyển Registration thành Redis job và thêm progress vào React OIDC dashboard. Bác bỏ hai đề xuất bằng A1 201/409 + unique email, package không có Redis, callback React còn placeholder.",
    "<b>Prompt test:</b> sinh test risk-based cho idempotency, failure, pairwise và biên. Xóa test yếu “GET hai lần vẫn 200”; sửa test sleep 100ms thành polling deadline. Giữ T01–T12 và kiểm đủ 27 cặp bằng 9 hàng.",
    "<b>Prompt patch:</b> thêm store/router/UI nhỏ không dependency, không đổi OIDC/Registration. Sửa lỗi TypeScript union, format lại JS UI sau review diff; chạy build, test, browser.",
    "<b>Prompt verify:</b> đổi &gt;→&gt;= tạm rồi chạy T06; revert trên nhánh nộp. Commit mutant 23e0080, T06 fail 400/202, bản nộp pass.",
])
story += [p("Output dùng: cấu trúc TaskStore/route, ma trận pairwise, test harness. Output sửa/bác bỏ: Redis/Registration, React dashboard, hai test yếu, claim exactly-once. Bằng chứng chi tiết ở ai-usage.md, plan.md và review.md.")]

# Appendix B — excerpts, not whole logs.
story += [p("PHỤ LỤC B · Trích log thực thi", "title")]
story += [p("<b>Red:</b> T01/T02, expected 202; actual 404; 1 fail — `red.log`.")]
story += [p("<b>Green:</b> slice 12/12 pass; full suite 25/25 pass, 0 skip; headers pass — `pass.log`, `full-suite.log`, `headers.log`.")]
story += [p("<b>Mutation:</b> T06, expected 202; actual 400; 1 fail trên commit 23e0080 — `mutation.log`.")]
story += [p("<b>Coverage:</b> routes 98,67% line / 85,71% branch; store 100% line / 92,59% branch — `coverage.log`.")]
story += [p("<b>Load 200:</b> p95 ack 350,74 ms; p95 completion 556,42 ms; target 5.000 ms — `load.json`.")]
story += [p("<b>Browser:</b> Chrome headless `/demo-tasks`, final `succeeded — 100%` — `browser.json`.")]
story += [p("<b>Nhiễu build:</b> 3 test M2 cũ trong `dist` sau đổi nhánh; dọn `dist` và chạy lại full suite 25/25 — `stale-dist.log` và `full-suite.log`.")]
story += [Spacer(1, 12), p("Nguồn đầy đủ: <link href='https://github.com/SE2026-T28/SE2026-T28/tree/feat/bt3-vt114-async-tasks/docs/bt3-vt114'>docs/bt3-vt114 trên GitHub branch</link>.", "small")]
story += section("PHỤ LỤC C · Đối chiếu yêu cầu")
story += [table(["Nhóm yêu cầu", "Trạng thái", "Bằng chứng kiểm tra"], [
    ["Spec và AI plan", "Đủ", "4 AC, 2 ràng buộc, invariant; plan trước code; 2 đề xuất AI bác bỏ bằng repo."],
    ["Test strategy", "Đủ", "12 test case, 9 tổ hợp pairwise, negative/failure, unit/API/E2E và test không cần thiết."],
    ["Test-first slice", "Đủ", "Branch riêng, baseline, commit red 404, patch, 12/12 pass, README, Draft PR #19."],
    ["Mutation và chất lượng", "Đủ", "Mutant &gt;→&gt;= bị T06 bắt; line/branch, risk coverage, 2 nguồn flaky, tải 200."],
    ["Evidence và reflection", "Đủ", "Traceability, AI Usage Log, 2 nhận định AI bị giới hạn, reflection 337 từ."],
], [122, 66, 313], tiny=True)]
story += [Spacer(1, 7), p("<b>Giới hạn phải giữ khi nộp:</b> 200 task là giả lập trên loopback; store không bền vững, không có giao dịch hay thông báo thật. Slice chỉ chứng minh contract trong một process; không khẳng định đã triển khai hệ thống tác vụ production.", "small")]


def decorate(canvas, doc):
    canvas.saveState()
    width, height = A4
    canvas.setStrokeColor(colors.HexColor("#C9D8DC"))
    canvas.line(16 * mm, height - 14 * mm, width - 16 * mm, height - 14 * mm)
    canvas.setFont("DejaVu", 7)
    canvas.setFillColor(GRAY)
    page = doc.page
    label = f"BT3 · VT-114 · Trang {page}"
    canvas.drawString(16 * mm, 11 * mm, label)
    canvas.drawRightString(width - 16 * mm, 11 * mm, "Đặng Minh Quang · 24002070")
    canvas.restoreState()


doc = SimpleDocTemplate(
    str(OUTPUT), pagesize=A4,
    leftMargin=16 * mm, rightMargin=16 * mm,
    topMargin=18 * mm, bottomMargin=17 * mm,
    title="BT3_24002070_VT-114",
    author="Đặng Minh Quang",
)
doc.build(story, onFirstPage=decorate, onLaterPages=decorate)
print(OUTPUT)
