import type { Post } from "../../lib/blog.ts";

export const post: Post = {
  slug: "ai-knowledge-base",
  title: "Give the Q&A assistant your own answers",
  description:
    "Add your FAQ, policies and notes to AI knowledge, import an Obsidian vault, and let the Q&A assistant draft answers from them that you check before posting.",
  date: "2026-10-24",
  category: "tutorials",
  tags: ["ai", "knowledge", "q-and-a", "engagement"],
  body: `
    The same questions come up in every session: the fees, the batch timings, the refund policy. With **AI knowledge**, you give the Q&A assistant your own material once. During a live session it drafts answers from it, and you check, edit and post them. Nothing is posted without you.

    > [!NOTE] Available on request
    > AI knowledge is part of the AI features, which are off by default for every host. It needs AI switched on for your account, and AI knowledge switched on as well. Ask us to turn them on.

    ## Open your library

    Once it is on, **AI knowledge** appears in the sidebar. Your library belongs to your account, and every session uses it. The usage line shows how much room you have left.

    | | |
    |---|---|
    | Documents | Up to 50 |
    | Words | Up to 50,000 per document, 250,000 in all |
    | Uploads | Up to 10 MB |

    ## Add a document

    Under **Add a document** there are three ways in.

    ### Paste text

    Give it a **Title**, such as "Course FAQ", paste the **Text** and press **Add document**. Hinglish is fine.

    ### Upload a file

    Upload a PDF, Word (.docx), .txt or .md file and press **Upload**. If you leave the title empty, the file name is used. Only the text is kept, not the file, so it does not count toward your recording storage.

    > [!WARNING] Scanned PDFs have no text
    > A scanned PDF is pictures of pages, with no text in it. Paste the text instead. Old .doc files and password-protected files cannot be read either.

    ### Import an Obsidian vault

    If you keep your notes in Obsidian, choose **✨ Obsidian vault**, pick a zip of your vault's folder (up to 10 MB) as the **Zipped vault**, and press **Import notes**.

    - Each note becomes its own document. If a note starts with a \`# Heading\`, that is its title; otherwise the file name is.
    - Each document is tagged with its folder, shown like **Course › Week 1**.
    - Front matter and comments are dropped, and \`[[links]]\` become plain words: \`[[Fees|fee table]]\` reads as "fee table".
    - Settings, hidden folders, pictures, other files and empty notes are skipped.

    The import is all or nothing. If the vault does not fit in your library, nothing is imported, and you are told how much room is left. Zip only the notes the assistant needs, or delete some documents first.

    > [!TIP] Upload a single note as a file
    > A single .md file uploaded on its own keeps its front matter and \`[[links]]\` as they are. Use the vault import if you want them cleaned up.

    Each document has **View text**, so you can see exactly what the assistant reads, and **Rename**. Deleting a document stops the assistant using it in every session, including live ones. Answers you have already posted stay as they are.

    ## Choose what each session uses

    Every session uses every document unless you say otherwise. On a webinar's or meeting's **Setup** tab, the **Knowledge for this session** card lists your documents. Untick any that this session should not use, and tick or untick **Past answers** (below).

    ## In the room: drafts you check

    When questions arrive, the assistant looks for the parts of your material that match each one, and drafts an answer from them for you to check. Drafts appear in two ways:

    - Press **✨ Suggest an answer** on a question.
    - Or let it come to you: when a new question has a strong enough match, a draft appears on its own.

    A draft is marked **Drafted for you · only hosts see this** (or **Suggested answer** when you asked for it), with chips showing which documents it came from. You can **Post answer**, **Edit** it first, **Mark answered**, **Try again** or **Discard**. Posting is the only way an answer reaches your audience, and they see it as answered by the host team.

    If several people ask the same thing, the questions are grouped, and one answer can go to all of them.

    ## How it stays grounded

    The assistant is built to say nothing rather than guess.

    - It answers only from your documents, your past answers, or what was said in the last few minutes of the session.
    - Every fact in a draft has to be in that material: prices, dates, links, names and policies. Numbers are copied exactly, never rounded or converted, and a draft whose numbers do not match its source is thrown away.
    - If your material does not fully answer the question, there is no draft. You will see **No confident answer in your knowledge**, with **Add to knowledge** so you can fill the gap for next time.
    - Weak matches are not even sent to the AI. And text inside your documents is treated as material, never as instructions.

    Drafts are short: two to four plain sentences. A question in Hinglish gets a Hinglish answer, in Roman script.

    > [!TIP] Fill the gaps as you go
    > **Add to knowledge** opens your library in a new tab with the question already filled in. Type the answer, press **Add document**, and the next time it is asked, the assistant can draft it.

    ## Past answers

    Your own answers are often the best material. Under **✨ Past answers** in your library you will find what you answered in earlier sessions, saved when each one ends:

    - **Typed answers** are saved as they are.
    - **Answers you gave out loud** are drafted from the transcript, marked **Drafted from what you said**, and wait for you to **Approve**, **Edit** or **Skip**. Only approved ones are used.

    Only the question and answer are kept, never who asked, and phone numbers and emails are removed. If the same question is answered again later, the saved answer is updated, and you can undo that. Sessions with AI switched off are never read.

    ## Simulive Auto mode

    In a [Simulive](/blog/turn-a-recording-into-a-simulive), Auto mode can post answers from your knowledge without waiting for you, with stricter rules than live drafts. Those answers are signed as your assistant. It is a separate switch, available on request, and needs AI, Simulive and engagement replay. [How Simulive keeps every viewer on the same moment](/blog/simulive-keeping-every-viewer-on-the-same-moment) explains the replay underneath it.

    ## Next

    - After the session, read your [AI recap](/blog/ai-recap-and-insights): it lists the questions that were not answered.
    - Run Q&A, polls and chat well with [Engage your audience](/blog/engage-your-audience).
  `,
};
