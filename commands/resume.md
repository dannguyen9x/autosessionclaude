---
description: Load the most recent autosession handoff and continue the previous session's work from where it stopped.
argument-hint: "[optional extra instruction]"
allowed-tools: Read, Glob, Bash(ls:*)
---

Tiếp tục công việc từ phiên Claude Code trước đó (phiên cũ đã đầy context và đã ghi
lại một bản "handoff").

Làm theo đúng thứ tự:

1. Tìm và đọc bản handoff MỚI NHẤT:
   - Ưu tiên đọc `./.autosession/latest-handoff.md` nếu tồn tại.
   - Nếu không có, liệt kê `./.autosession/handoffs/` và đọc file `.md` mới nhất
     (tên có timestamp lớn nhất).
   - Nếu không tìm thấy handoff nào, báo cho tôi biết là chưa có gì để tiếp tục.

2. Đọc kỹ toàn bộ handoff để hiểu: mục tiêu gốc, những gì đã làm, trạng thái hiện
   tại, các file quan trọng, và các quyết định/lưu ý.

3. Bắt đầu làm ngay từ mục **"Next steps"** trong handoff. Tự quyết định hợp lý,
   KHÔNG hỏi lại, cứ tiếp tục cho tới khi đạt "Done criteria".

$ARGUMENTS
