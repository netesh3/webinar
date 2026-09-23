# What we need from Facebook (Meta) — instructions for whoever runs this

This is a hand-off sheet. Give it to the person who has access to the Facebook /
Meta account. They do not need to be a developer. Everything below is clicking
around two websites and copying numbers into a message back to us.

There are two kinds of task in here, and it matters which is which:

- **Collect** — a value that lives inside Facebook. Find it, copy it, send it back.
- **Paste in** — a value *we* give *them*, which has to be typed into Facebook.
  These are not found anywhere in Facebook; if they go looking for them they will
  not find them, and inventing one will break the connection.

At the very end there is a fill-in-the-blanks form. The job is done when every
line of that form is filled and every checkbox in Part 4 is ticked.

---

## Before they start — what to send them

The person will need these from us, in the same private message as this document:

| Thing | Value |
| --- | --- |
| Our website (web) address | `https://webinarliv.com` |
| Our webhook callback URL | `https://webinarliv.com/api/webhooks/whatsapp` |
| Our webhook "Verify token" | *(48-character string — see the warning below before sending it)* |

**Do not generate a new verify token.** One already exists and the server is
already using it. If a new one is typed into Facebook, webhooks stop working
until the server is updated to match.

> **⚠ Reconcile the verify token before handing it over.** As of 2026-09-23 the
> `META_WEBHOOK_VERIFY_TOKEN` in the local `.env` is **not** the one the deployed
> API is running — a live handshake against the token in `.env` is refused:
>
> ```
> curl --get \
>   --data-urlencode "hub.mode=subscribe" \
>   --data-urlencode "hub.verify_token=$TOKEN" \
>   --data-urlencode "hub.challenge=ping" \
>   https://webinarliv.com/api/webhooks/whatsapp
> ```
>
> A correct token answers **200** with the body `ping`. A wrong one answers
> **403 `{"error":"forbidden"}`**, and an unset one answers **503
> `whatsapp_webhook_unset`** — so the three cases are easy to tell apart.
>
> The GitHub Actions secret cannot be read back, so pick one token, set it in
> **both** `.env` and the `META_WEBHOOK_VERIFY_TOKEN` repository secret, redeploy
> the API, and confirm the command above returns 200. Only then send the token on.
> Skipping this means Part 3 step B fails with "the callback URL or verify token
> couldn't be validated" and the person will assume they did something wrong.

---

## Part 0 — Access they need first

They must be logged into Facebook with an account that is an **Admin** of:

1. the **Meta Business portfolio** (also called Business Manager) for our company, and
2. the **Meta app** inside it.

Two websites are used throughout:

- **developers.facebook.com** — the app, the WhatsApp settings, the webhook.
- **business.facebook.com** — the company profile, business verification.

How to check they have the right access: go to
<https://developers.facebook.com/apps/> and confirm our app is listed. If the
list is empty or our app is missing, stop — they have the wrong login, or they
need to be added as an app Admin first. Nothing else in this document will work
until that is fixed.

> **A note on the App Secret (item 2 below).** Only an app **Admin** can reveal
> it, and it is the single most dangerous value in this document — it can sign
> requests as us. If we would rather not give someone Admin on the app, the
> cleanest split is: we fetch the App Secret ourselves, and they do everything
> else with a **Developer** role.

---

## Part 1 — Five values to collect FROM Facebook

### 1. App ID

*What it is:* the public ID number of our Meta app. 15–16 digits.

1. Go to <https://developers.facebook.com/apps/>.
2. Click our app (this opens its Dashboard).
3. In the **left sidebar**, scroll to the bottom: **App settings → Basic**.
4. The very first field on that page is **App ID**. There is a copy icon beside it.

*Send back as:* `META_APP_ID`

*We believe this is already `1102320812738138`.* Their job on this one is just to
confirm it matches. If it does not, something is pointing at the wrong app and
they should tell us before continuing.

---

### 2. App Secret

*What it is:* the password for the app. 32 characters, letters and numbers.

1. Same page as above: **App settings → Basic**.
2. The field directly under App ID is **App secret**, shown as dots with a
   **Show** button.
3. Click **Show**. Facebook will ask for the Facebook account password again.
4. Copy the revealed value.

*Send back as:* `META_APP_SECRET`

**Handle this one like a bank password.** It must arrive through a private
channel — a password manager share, or 1Password/Bitwarden, or an
end-to-end-encrypted message. **Not** email, not Slack, not a Google Doc, not
this document, not a screenshot in a ticket.

If Facebook offers a **"Reset"** button next to it: we actually *want* it reset
once, because the current secret was previously pasted somewhere it should not
have been. So the ideal sequence is: click **Reset**, then copy the **new**
value and send that. Resetting breaks nothing permanently — the WhatsApp
features simply stop working for the few minutes between the reset and us
updating our server with the new value. **Tell us before resetting** so we can
be ready to update it immediately.

---

### 3. Embedded Signup Configuration ID

*What it is:* the ID of a saved configuration that controls the pop-up window our
customers see when they connect their WhatsApp. 15–16 digits. This is **not** the
App ID, even though it looks like the same kind of number.

1. In the app's **left sidebar**, find **WhatsApp** (under "Products").
2. Click **WhatsApp → Embedded Signup**. (Meta has also shipped this as
   **Embedded Signup → Configurations**, or nested under
   **Facebook Login for Business → Configurations** — if one path is missing,
   try the other; it is the same screen.)
3. There is a list of configurations. Ours is named **`webinarlivCRM`**.
4. Copy the **ID / Configuration ID** shown in that row.

*Send back as:* `META_WHATSAPP_CONFIG_ID`

*We believe this is already `1592143732554543`.* Again — confirm, don't replace.

If **no configuration exists at all**, one has to be created: click **Create
configuration**, name it `webinarlivCRM`, choose the WhatsApp Embedded Signup /
"WhatsApp Business account onboarding" flow, save, and then copy the new ID.

---

### 4. WhatsApp Business Account ID (the "WABA ID")

*What it is:* the ID of the WhatsApp account we test with. 15–16 digits.

1. **WhatsApp → API Setup** in the left sidebar (sometimes called
   **Getting Started** or **Quickstart**).
2. Partway down there is a box headed **"Send and receive messages"** with
   several dropdowns.
3. Under the dropdowns, look for **WhatsApp Business Account ID**. Copy it.

*Send back as:* `WABA_ID (test)`

*We believe this is already `3350913338447626`.*

---

### 5. Phone Number ID

*What it is:* the ID of the specific test phone number. **Not** the phone number
itself — a long numeric ID, 15–16 digits.

1. Same **WhatsApp → API Setup** page.
2. In the **"From"** dropdown, the test number is selected (ours reads
   **+1 (555) 156-9690**).
3. Directly beneath that dropdown is **Phone number ID**. Copy it.
4. Also copy the human-readable phone number shown in the dropdown, so we can
   double-check they are looking at the right one.

*Send back as:* `PHONE_NUMBER_ID (test)` and `Test phone number`

*We believe these are already `1351291858063397` and `+1 (555) 156-9690`.*

---

## Part 2 — Two values that do NOT come from Facebook

Include these in the hand-off so nobody wastes an afternoon hunting for them.

**`META_WEBHOOK_VERIFY_TOKEN`** — a random string *we* invented. It is not
displayed anywhere in Facebook. It gets **typed into** Facebook in Part 3, step
B. We already have ours; use it exactly as given.

**`WHATSAPP_GRAPH_URL`** — the address of Meta's API, including its version
number (`https://graph.facebook.com/v23.0`). It is already built into our
software and should be left alone. Nothing to collect, nothing to change.

---

## Part 3 — Four things to change INSIDE Facebook

Collecting the numbers above is not enough on its own. These four settings are
what actually make the feature work, and they can only be done in the Meta
console.

### A. Allow our website to open the WhatsApp pop-up

Without this, the "Connect WhatsApp" button on our site opens a pop-up that
immediately errors.

1. Left sidebar → **App settings → Advanced**.
2. Find the **Security** section, and within it
   **"Allowed domains for the JavaScript SDK"** (in some accounts this lives
   under **Facebook Login for Business → Settings**, same field name).
3. Add exactly: `https://webinarliv.com`
4. Click **Save changes** at the bottom of the page.

If there is also a field called **"Valid OAuth Redirect URIs"** (under
**Facebook Login for Business → Settings**), add `https://webinarliv.com` there
too. It costs nothing and some flows check it.

### B. Point Facebook at our server, so incoming WhatsApp messages reach us

1. Left sidebar → **WhatsApp → Configuration**. (Older layout:
   **WhatsApp → Configuration → Webhooks**; or app-wide under
   **Webhooks → WhatsApp Business Account**.)
2. In the **Webhook** box, click **Edit**.
3. **Callback URL:** `https://webinarliv.com/api/webhooks/whatsapp`
4. **Verify token:** the 48-character token we sent them. Paste it exactly — no
   spaces before or after, no line breaks.
5. Click **Verify and save**.
   - **This is the moment of truth.** Facebook immediately calls our server. If
     it says *"The callback URL or verify token couldn't be validated"*, then
     either the token does not match ours character-for-character, or our server
     is not deployed yet. Tell us, don't guess — do not change the token to make
     the error go away.

### C. Subscribe to the two event types we actually use

Still on **WhatsApp → Configuration**, in the **Webhook fields** box:

1. Click **Manage**.
2. Tick **`messages`** — this is how a customer's reply reaches our inbox.
3. Tick **`account_update`** — this is how we learn that a host finished
   connecting their WhatsApp account.
4. Save. Both should now show a green tick / "Subscribed".

Nothing else needs ticking. Extra subscriptions are just noise our server will
ignore.

### D. The slow approvals (start these now; they take days to weeks)

Everything above is enough for **us** to test with **our own** number. To let
**paying customers** connect **their** WhatsApp numbers, Meta requires three
separate approvals. They are queues, not tasks — start them early and then
forget about them.

1. **Business Verification** — at <https://business.facebook.com/> →
   **Business settings → Business info → Security Centre → Start verification**.
   Meta asks for our legal business name, address, a business phone number or
   email it can confirm, our website, and a document (certificate of
   incorporation, utility bill, or similar). **Turnaround: a few days to a few
   weeks.** The single most common reason for rejection is the name/address on
   the document not matching the name/address typed into the form exactly —
   including abbreviations like "Ltd" vs "Limited".

2. **Tech Provider registration** — in the app dashboard, under
   **WhatsApp → Embedded Signup** (or **Business settings → Requests**) there is
   a prompt to register as a **Tech Provider** / **Solution Partner**. Business
   Verification must finish first. There is also an **Access Verification** step
   that may follow.

3. **App Review → Advanced Access** for two permissions:
   `whatsapp_business_messaging` and `whatsapp_business_management`. Left
   sidebar → **App review → Permissions and features**, find each permission,
   click **Request advanced access**. Each one needs a written explanation of
   why we need it and a **screen recording** of the feature being used. We will
   write the text and record the screens — they just need to tell us when this
   step is unblocked and paste what we send.

**They should not wait on these to send back Part 1.** Send the numbers as soon
as they have them; the approvals continue in the background.

---

## Part 4 — Checklist to send back

Copy this, fill it in, and return it. Split it into **two** messages: the
ordinary values in a normal message, the App Secret on its own through a
password manager or encrypted channel.

```
--- Message 1 (normal channel) ---
META_APP_ID                =
META_WHATSAPP_CONFIG_ID    =
WABA_ID (test)             =
PHONE_NUMBER_ID (test)     =
Test phone number          =

Part 3 actions:
[ ] A. https://webinarliv.com added to Allowed domains for the JavaScript SDK, saved
[ ] B. Webhook callback URL + verify token saved, and Facebook said "verified"
[ ] C. Subscribed to `messages`
[ ] C. Subscribed to `account_update`
[ ] D. Business Verification submitted   (date submitted: ______)
[ ] D. Tech Provider registration submitted, or blocked on verification
[ ] D. App Review requested for whatsapp_business_messaging
[ ] D. App Review requested for whatsapp_business_management

Anything that did not match what the document said it would be:


--- Message 2 (password manager / encrypted only) ---
META_APP_SECRET            =
Was it reset to a new value?  yes / no
```

---

## Two things to be careful about

**Where these values are allowed to live.** On our side, every secret goes in
exactly two places: the server's `.env` file (which is never committed to the
code repository) and the GitHub Actions repository secrets used for deployment.
They must never be pasted into example files, into code, into a commit message,
or into any file that gets checked in. If a secret ever does land in one of those
places, the fix is to rotate it in the Meta console, not to delete the file.

**The test number has hard limits.** Meta's free test number can only send to a
small list of recipients (5 maximum) that have to be added by hand in the console
under **WhatsApp → API Setup → To**. It also has no payment method attached, so
it cannot exercise the real billing path. That is expected, not a bug. Real
sending only starts working once a customer connects their own WhatsApp Business
Account and puts a card on it — Meta bills **them**, not us.
