# Data disclosure matrix — C8 Chat

This is the internal rationale for the Chrome Web Store privacy fields and the
AMO manifest declaration. It must stay consistent with `PRIVACY.md`.

## Data types

| Data | Accessed | Stored locally | Sent off-device | CWS checkbox | AMO permission |
| --- | --- | --- | --- | --- | --- |
| Player/user names | Yes | Yes (chat log, diag samples) | No | Personally identifying information | none |
| Room chat / private messages | Yes | Yes (300-line scrollback) | Only the user's own message to the game server | Personal communications | none (fallback: personalCommunications) |
| Game page / WebSocket content | Yes | Small diagnostic samples | No | Website content | none |
| Current game URL | Yes | Yes (diag `href`) | No | Website content | none |
| Panel placement/settings | Yes | Yes | No | Not listed | none |
| Game session key | Read in memory only | No | No | Not selected; explain in policy | none |
| Cookies / passwords / browsing history | No | No | No | Not selected | none |
| Location / health / financial | No | No | No | Not selected | none |

## Chrome Web Store

- Select **Personally identifying information**, **Personal communications**, and
  **Website content**.
- Explain in the privacy policy that processing is local and that diagnostic
  samples may include chat text, player names, and the current game URL.
- Do not select health, financial, location, or web history.
- Answer remote code **No**.
- Certify the Limited Use statements.

## AMO

The manifest declares:

```json
"data_collection_permissions": {
  "required": ["none"]
}
```

AMO defines transmission as data handled outside the add-on or the local browser.
All C8 Chat storage is local. The only outbound traffic is:

- The game's own WebSocket, which the user directs and which C8 Chat observes in
  place. The private-message frame is the game's own `0x19` message.
- A same-site `GET /api/players` with `credentials: "omit"`; it sends no account
  cookies and stores no response beyond the in-memory recipient list.

If a reviewer treats the user's synthesized private-message frame as transmission,
the fallback declaration is `required: ["personalCommunications"]`. That adds an
install consent prompt and requires updating `PRIVACY.md`, the listing, and the
reviewer notes. Do not change the declaration without changing all three.

## Account key

The agent reads the game session key in memory to redact it from forwarded and
stored data. It is never stored, displayed, or transmitted. The Chrome dashboard's
"Authentication information" checkbox is not selected; the privacy policy and
reviewer notes explain the transient read. If Chrome asks for it, select it and
keep the same explanation.

## Private browsing

`"incognito": "not_allowed"` is set, so private-window data cannot be written to
the shared extension store. This satisfies AMO policy 6.3.2.
