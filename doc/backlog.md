- [ ] Refined bot. (from v1.1)
    - Take this to workspace agent with Github repo

        ```
        Right now, I think the bot is only being made to work well within the scenarios we want it to pass.
        It lacks flexibility or the ability to analyze things independently.
        It's like a bot that hasn't progressed much from the old rule-based bots.
        This is what we told the client: we wanted to build a chatbot that truly understands context, works independently like a real admin who can answer questions to a certain extent.
        But this feels like we're modifying it word by word.

        I think we might need to redesign the entire system.

        Don't do anything yet. Analyze what it should be like and how to design it so that it has enough value to deliver according to the requirements.

        Even though we said it wouldn't be a ready-made bot.

        ```

    - อาจจะต้องเพิ่ม Agent ที่ตรวจเช็คข้อความก่อนส่งออกไปอีกที เพื่อป้องกันการ Hallucination (ใช้ Model เล็กได้) อยาก issue จากการ Test v.1 เราพบว่ามีการข้อความที่ตอบผิดพลาดอย่าง
    - อาจจะต้องทำรายการ Scenario เป็น intent เพื่อให้ตอบได้ตรงมากขึ้น
    - การใช้ Emoji v.1 - v.1.1 ทุกการตอบของ Agent Lay จะพยายามใส่ emoji 😊 และพยายามให้ user ถามต่อ ซึ่งมันขัดแนวทางของเราที่จะไม่ให้ผู้ใช้ อยู่กับเราให้นาน การถามเช่น "หากสนใจข้อมูลเพิ่มเติมเกี่ยวกับบริการไหน สามารถสอบถามได้เลยครับ 😊" ตลอดเวลาจึงไม่ต่างจากที่ ธุรกิจ AI เจ้าใหญ่ทำ ควรมีการวิเคราะห์หรือแยกว่า ควรใช้เมื่อไหร่ ควรถาม หรือ CTA เมื่อไหร่
    - ควรจะมี มาตรฐานหรือ SOP ที่ชัดเจนในการตอบ แต่ละ Scenario เหมือนเอกสาารไว้เทรน Admin ว่าควรตอบอย่างไร ตอนนี้ (v1.1) การตอบแต่ละครั้ง ไม่เหมือนกัน (ยังเป็นการตอบแบบ llm ตอบ ที่มีการสุ่ม)

    ```
    10:33 Mos(NRC) สนใจจ้างทำบอทครับ
    10:33 LazyHardWork |Studio [Agent Lay]

    ขอโทษครับ ตอนนี้อยู่นอกเวลาทำการ (13:00–22:00)

    แนะนำให้ท่านโทรช่วงเวลาทำการ หรือสามารถฝากข้อความไว้ได้ครับ สามารถดูรายละเอียดเพิ่มเติมเกี่ยวกับบริการได้จากที่นี่ครับ:

    - LINE OA แชทบอต AI
    - ออโตเมชันงานซ้ำด้วย AI
    - เซตอัป AI ผู้ช่วยให้ทีม

    หากต้องการข้อมูลเพิ่มเติมหรือช่วยเหลือในการเริ่มต้น สามารถติดต่อที่ 0955691674 หรือส่งอีเมลไปที่ naruecha.ps@hotmail.com ได้เลยครับ
    10:35 Mos(NRC) สนใจจ้างทำบอทครับ
    10:35 LazyHardWork |Studio [Agent Lay]

    ดีใจที่สนใจจ้างทำบอทครับ 😊

    สามารถเล่าให้ฟังได้ไหมครับว่าต้องการให้บอททำงานอะไรบ้าง หรือมีฟีเจอร์ไหนที่ต้องการเป็นพิเศษ? เพื่อให้เราสามารถเสนอแพ็กเกจที่เหมาะสมกับความต้องการของคุณได้ครับ

    10:36 Mos(NRC) สนใจจ้างทำบอทครับ
    10:36 LazyHardWork |Studio [Agent Lay]

    ดีใจที่สนใจครับ 😊 เรามีบริการสร้างบอท AI ที่สามารถตอบลูกค้า รับออเดอร์ หรือจองคิวได้อัตโนมัติ 24 ชั่วโมง

    ราคาสำหรับการสร้างบอทเริ่มที่ 15,000 บาท สำหรับแพ็ก Starter ครับ สามารถสอบถามรายละเอียดเพิ่มเติมหรือขอให้ Mos ติดต่อกลับได้เลยครับ

    ท่านสนใจแพ็กไหนหรือมีคำถามเพิ่มเติมเกี่ยวกับบอทไหมครับ?
    10:36 Mos(NRC) สนใจจ้างทำบอทครับ
    10:36 LazyHardWork |Studio [Agent Lay]

    ยินดีต้อนรับครับ 😊

    เรามีบริการสร้างบอท AI ที่สามารถตอบลูกค้า รับออเดอร์ และจองคิวอัตโนมัติ 24 ชั่วโมง พร้อมรับฟังภาษาคนจริง

    ราคาสำหรับบริการนี้เริ่มต้นที่ 15,000 บาท หากสนใจสามารถเลือกแพ็กที่เหมาะกับงานได้เลยครับ

    มีข้อมูลเพิ่มเติมต้องการหรืออยากปรึกษากับคุณ Mos โดยตรงไหมครับ? หากอยากติดต่อ Mos สามารถโทร 0955691674 หรือส่งอีเมลไปที่ naruecha.ps@hotmail.com ได้ครับ

    แจ้งได้เลยถ้าต้องการข้อมูลเพิ่มเติมครับ 😊
    10:37 Mos(NRC) สนใจจ้างทำบอทครับ
    10:37 LazyHardWork |Studio [Agent Lay]

    ขอบคุณที่สนใจจ้างทำบอทครับ 😊

    เรามีแพ็กเกจบริการที่คุณสามารถเลือกได้ดังนี้:

    1. **Starter** - 15,000 บาท: งานเล็ก, FAQ + เมนูพื้นฐาน, 1 บริการหลัก
    2. **Advanced** - 20,000 บาท: งานกลาง, หลายฟีเจอร์, integration 1–2 อย่าง
    3. **Operation** - 30,000 บาท: งานครบวงจร — หลายระบบ, ส่งต่อทีมอัตโนมัติ, แจ้งเตือน real-time

    คุณสนใจแพ็กเกจไหนครับ? หรืออาจจะมีคำถามเพิ่มเติมเกี่ยวกับบริการใช่ไหมครับ?

    ```

## v2 (2026-10-17)

Should / Later items collected from the module docs (`doc/flows.md`, `doc/demo.md`, `doc/richmenu.md`,
`doc/discord.md`, `doc/leads.md`, `doc/store.md`) and `decisions.md` D-19. None blocks the Tuesday cut-over.

- [ ] **3-min idle loose-ends** — today the loose-ends check fires only on a closing signal (turn step 7); the
      brief's time-based trigger needs a timer or a cron over `sessions.last_customer_at`.
- [ ] **Per-user Rich Menu swap in demo** — `richmenu.linkDemo/unlinkDemo` exist and never throw, but `turn.js`
      does not call them on `demo_enter` / `demo_exit`; the demo works with the `กลับไปคุยกับ Lay` quick reply alone.
- [ ] **Guild slash commands** — `/approve /propose /decline /lay` as real Discord slash commands
      (`DISCORD_REGISTER_COMMANDS=1`, `commands.slashDefinitions`); plain `/` lines in the thread already work.
- [ ] **Returning-visitor memory** — a customer who comes back after days should not be re-opened and re-asked;
      today the opening is per session flag and homework persists, but there is no "welcome back" path.
- [ ] **Monthly kb-gap report** — `kb_gaps` rows are stored and posted one by one; no digest to the vault yet.
- [ ] **Engine migration** — SQLite behind `createStore` is the single-instance design; Postgres (or the shared
      store for client installs) touches `src/store/` only (`doc/store.md`).
- [ ] **Placeholder example images** — `public/assets/examples-*.png` are generated colour blocks; replace with
      real screens, same file names, 16:9 (`doc/demo.md` table). Demo shop icons likewise.
- [ ] **Fastwork handle conflict** — profile says `moslazyhardwork`, ledger/cards say `mos_lazyhardwork`; the pack
      emits no handle until Mos settles it (D-19). `turn.cardContext` still carries a hard-coded fallback URL.
- [ ] **Summary-card pill in demo** — `status_label` override exists ("รอร้านยืนยัน"); a proper `pending_shop`
      status would make the template self-describing.
- [ ] **Injection scenario suite** and the 10 Mos scenarios from the Fastwork history (T13) — only four scenarios
      exist today; `sanitizeInput` has no dedicated test.
- [ ] **Open experience questions for Mos** — `doc/flows.md` §6 (offer card then ask for window? booking vs live
      handoff on นัดคุยกับมอส? who speaks the approve line?) — provisional answers are coded, not confirmed.
