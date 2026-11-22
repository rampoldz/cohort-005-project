# Hosted services for in-app Notifications on a free tier

Research for [issue #26](https://github.com/rampoldz/cohort-005-project/issues/26), part of the map in [issue #25](https://github.com/rampoldz/cohort-005-project/issues/25).

- **Read on:** 2026-11-21. Pricing and free-tier limits change often; every figure below is what the vendor's own page said on that date.
- **Sources:** vendor pricing pages, vendor documentation, vendor SDK repositories and the npm registry only. Each claim carries its source URL.
- **"Unverified"** means the vendor's own pages did not state it, or the page could not be fetched. Nothing unverified is filled in from memory.
- **Scope:** in-app only. Email capability is noted in one line per service and not evaluated.

## Shortlist

Knock, Novu (cloud), Courier and MagicBell. All four are hosted, have a $0 plan, ship a prebuilt React inbox plus a headless route, deliver over a WebSocket, and have a Node SDK.

## Comparison

| | Knock | Novu (cloud) | Courier | MagicBell |
| --- | --- | --- | --- | --- |
| Free plan | "Free", $0 | "Free", $0 | "Developer", $0 | "Builder", $0 |
| Monthly allowance | 10,000 messages | 10,000 workflow runs | 10,000 sends | 1,000 deliveries |
| Other free caps | None on workflows, feeds, environments, stored profiles | 5 workflows, 2 environments, 3 team members, 24-hour activity feed retention | Not stated | 1 project; unlimited users and team members |
| Card required | No (stated) | No (stated) | Unverified (only the paid plan mentions adding a card) | Unverified |
| Vendor branding on free | Yes, removal is paid | Yes, removal is paid | Unverified | Unverified |
| Prebuilt React inbox | `NotificationFeedPopover`, `NotificationFeed`, `NotificationIconButton` | `Inbox`, `Bell`, `Notifications`, `InboxContent` | `CourierInbox`, `CourierInboxPopupMenu` | `Inbox`, `FloatingInbox` |
| Headless React | Hooks (`useNotifications`, `useNotificationStore`) | Hooks (`useNotifications`), plus `@novu/js` | `useCourier()` hook | Not documented for `@magicbell/react`; `magicbell-js` user client and `Realtime` class |
| Restyling the prebuilt UI | CSS variables (`--rnf-*`), own CSS on `rnf-*` classes, `renderItem`, `renderHeader` | `appearance` prop; Tailwind classes accepted per element | Theme object; `renderListItem`, `renderHeader`, `renderEmptyState` | CSS custom properties (`--magicbell-*`), classes, `ItemComponent` |
| Real time | WebSocket (Phoenix socket) | WebSocket (PartySocket on cloud) | WebSocket, started by `inbox.listenForUpdates()` | WebSocket |
| Per-person state | unseen, seen, read, archived; `interacted`, `link_clicked` events | read, seen, archived, snoozed | read, opened, archived; click tracked | read, seen, archived |
| Content lives | Vendor-side template on the workflow step; call passes `data` | Vendor-side workflow step; call passes `payload` | Either: vendor template, or inline `title` and `body` in the call | Inline `title` and `content` in the call |
| Browser auth | Public key alone by default; signed user token (RS256) once "enhanced security mode" is on | Public application identifier plus subscriber id; HMAC hash only if switched on | Server-minted JWT, documented as the only model | Server-signed user JWT (HS256), required by the provider |
| React 19 peer range | `^17 \|\| ^18 \|\| ^19` | `^18 \|\| ^19` | `>=18.0.0` | No peer range declared |
| Email later | Yes | Yes | Yes | Yes |

## Knock

**Free tier.** $0 a month, "no credit card required". Up to 10,000 messages a month, where a message is "A single message delivered to a single user on a single channel". The limit is not a hard cap: "We don't hard cap your messages", and Knock contacts you about billing if you go over. Included on Free: unlimited stored profiles, workflows, environments and in-app feeds, plus batching, preferences, conditional sending and scheduled workflows, with 30-day log retention. Not included: removing Knock branding, translations, per-tenant branding and preferences, audit logs, SAML. The next plan up is $250 a month. Source: https://knock.app/pricing

**React surface.** `@knocklabs/react` ships `NotificationFeedPopover` ("a managed popover for displaying a list of notifications"), `NotificationFeed` ("a full-page list of notifications") and `NotificationIconButton` (a bell with the unread or unseen count). It also "includes a complete set of React hooks that you can use to build your own UI on top of". Source: https://docs.knock.app/in-app-ui/react/overview

**Restyling.** The stylesheet import (`@knocklabs/react/dist/index.css`) is "Required CSS import, unless you're overriding the styling". Options are CSS variables prefixed `--rnf-`, replacing the CSS outright against classes prefixed `rnf-`, a `colorMode` prop for dark mode, `renderItem` to replace the notification cell and `renderHeader` to replace the header. Source: https://docs.knock.app/in-app-ui/react/feed. Tailwind classes cannot be passed into the prebuilt component through props; to use shadcn primitives the route is `renderItem` or the hooks. The headless route is `useKnockClient`, `useNotifications(knockClient, feedChannelId)` and `useNotificationStore(feedClient)`, which returns `items` and `metadata` (`unread_count`, `unseen_count`). Source: https://docs.knock.app/in-app-ui/react/custom-notifications-ui

**Real time.** Yes, without a reload. The client opens a WebSocket: `feedClient.listenForUpdates()` is commented "Connect to the real-time socket", and new items arrive on the `items.received.realtime` event. The client depends on the `phoenix` socket library. An option, `auto_manage_socket_connection`, disconnects sockets in inactive tabs and reconnects when they become active. Sources: https://github.com/knocklabs/javascript/blob/main/packages/client/README.md, https://github.com/knocklabs/javascript/blob/main/packages/client/package.json

**State per person.** Each message has an engagement status of "`unseen`, `seen`, or `read`", and can also be set to `archived`, which removes it from the feed. Clicks record an `interacted` event, and a `link_clicked` event when link tracking is on. The badge counts unseen messages by default; opening the feed marks them seen. Content cannot be changed after the message is generated. Source: https://docs.knock.app/integrations/in-app/knock. The client exposes `markAsRead`, `markAsSeen`, `markAsArchived` and the three reverse operations. Source: https://github.com/knocklabs/javascript/blob/main/packages/client/README.md. How long feed messages are retained is unverified; the pages read do not state it.

**Node SDK.** `@knocklabs/node` (1.41.1 on npm, generated with Stainless). Source: https://github.com/knocklabs/knock-node/blob/main/README.md

```js
import Knock from '@knocklabs/node';
const client = new Knock({ apiKey: process.env['KNOCK_API_KEY'] });
await client.workflows.trigger('dinosaurs-loose', {
  recipients: ['dnedry'],
  data: { dinosaur: 'triceratops' },
});
```

Content lives vendor-side: the call names a workflow and passes `data`, described as "A map of properties that are required in the templates in this workflow". The in-app template is edited on the workflow's in-app channel step in the dashboard, with Liquid variables. A recipient can be created in the same call: "You can pass a complete `Recipient` entity to the `recipients` or `actor` property when triggering a workflow." Sources: https://docs.knock.app/send-notifications/triggering-workflows/api, https://docs.knock.app/integrations/in-app/knock

**Browser authentication.** By default the public API key alone is enough; the docs warn that "Without enhanced security mode, a request with your public key can act as any user." With enhanced security mode on, the server signs an RS256 JWT with a `sub` claim (`signUserToken` from `@knocklabs/node/lib/tokenSigner`) and the client passes it as `userToken`. The mode is off by default and is set per environment. Source: https://docs.knock.app/in-app-ui/security-and-authentication. Either mode works with a user id chosen by the DevUI panel, because the recipient is just a string id.

**Email later.** Yes; workflows span channels and Free lists "unlimited ... delivery channels". Source: https://knock.app/pricing

**React 19 and server rendering.** `@knocklabs/react` 0.15.1 declares peers `react` and `react-dom` `^17.0.0 || ^18.0.0 || ^19.0.0`. Source: https://www.npmjs.com/package/@knocklabs/react. The docs pages read say nothing about server rendering. See the probe below.

## Novu (cloud)

**Free tier.** $0 a month, "No credit card required". 10,000 workflow runs a month; "Triggering a workflow to a single subscriber counts as 1 run". Up to 5 workflows, 2 environments (development and production), 3 team members, "Activity feed retention: 24 hours". All channels included, in-app among them. Novu branding stays on the Inbox; removal is a Pro feature ($30 a month and up). Source: https://novu.co/pricing. The branding toggle "is disabled on the free plan". Source: https://docs.novu.co/platform/inbox/prepare-for-production

Two points on that page are unverified:

- The comparison table has a separate "Inbox feed retention" row under end-user features, but its per-plan values could not be read from the page. Whether the 24-hour figure affects what a person sees in the Inbox, or only the dashboard's activity log, is unverified. It matters, because a Notification "stays until read".
- On exceeding the allowance the FAQ says "We never stop or throttle your notifications. Usage above your plan rolls into on-demand pricing". What that means for a Free account with no card is unverified.

**React surface.** `@novu/react` ships `<Inbox />`, a "prebuilt, ready-to-use, and fully customizable UI component", composed of `Bell`, `Notifications`, `InboxContent` and `Preferences`. Headless hooks are in the same package, and `@novu/js` gives "framework agnostic javascript methods". Source: https://docs.novu.co/platform/inbox/overview

**Restyling.** The `appearance` prop takes `baseTheme`, `variables`, `elements`, `icons` and `animations`. Tailwind is supported directly: "You can pass Tailwind CSS classes to specific elements using the elements object within the appearance prop." A dark theme is exported from `@novu/react/themes`. The Inbox injects its own styles into `<head>`. Source: https://docs.novu.co/platform/inbox/configuration/styling. There are also render props such as `renderBell`. Source: https://docs.novu.co/platform/sdks/react. The headless hook `useNotifications` returns `notifications`, `readAll`, `seenAll`, `archiveAll`, `fetchMore` and loading state. Source: https://docs.novu.co/platform/sdks/react/hooks/use-notifications

**Real time.** Yes, without a reload. The hook's list is "automatically updated in real-time when new notifications arrive or when notifications state (read, seen, archived, snoozed) changes", through a WebSocket subscription that the `realtime` option can switch off. Source: https://docs.novu.co/platform/sdks/react/hooks/use-notifications. `@novu/js` uses "`'cloud'` for PartySocket or `'self-hosted'` for socket.io" and emits `notifications.notification_received` and `notifications.unread_count_changed`. Source: https://docs.novu.co/platform/sdks/javascript

**State per person.** Read, seen, archived and snoozed. Each notification has `read`, `unread`, `seen`, `archive`, `unarchive`, `delete`, `snooze` and `unsnooze`. Seen is "designed as a one-way operation". Sources: https://docs.novu.co/platform/sdks/react/hooks/use-notifications, https://docs.novu.co/platform/sdks/javascript. Whether snooze is available on Free is unverified.

**Node SDK.** `@novu/api` (3.20.0 on npm). The older `@novu/node` package was last published 2025-12-12 and is not the one the docs use. Source: https://docs.novu.co/platform/sdks/server/typescript

```ts
import { Novu } from '@novu/api';
const novu = new Novu({ secretKey: '<YOUR_SECRET_KEY_HERE>' });
await novu.trigger({
  to: { subscriberId: 'subscriber_unique_identifier' },
  workflowId: 'workflow_identifier',
  payload: { comment_id: 'string' },
});
```

Content lives vendor-side: the quickstart has you "create a workflow, add an In-App step with a subject and body" in the dashboard, and the call passes `payload` variables into it. A subscriber that does not exist is created. Source: https://docs.novu.co/platform/quickstart/react. Because Free allows 5 workflows, a catalogue of more than five kinds of Notification would need either one generic workflow whose subject and body come from the payload, or a paid plan. That workaround is an inference from the documented payload variables, not something the Novu docs recommend.

**Browser authentication.** The Inbox needs the public `applicationIdentifier` and a `subscriberId`. An HMAC-SHA256 hash of the subscriber id (`subscriberHash`) is checked only when the "Security HMAC encryption" toggle is on in the In-App provider settings: "If HMAC encryption is active in In-App provider settings and `subscriberHash` is not provided, the Inbox will not load." Source: https://docs.novu.co/platform/inbox/prepare-for-production. Works with a DevUI-chosen user id either way.

**Email later.** Yes; Free lists "All channels, including Email, In-app, SMS, Chat, and Push". Source: https://novu.co/pricing

**React 19 and server rendering.** `@novu/react` 3.20.0 declares peers `react` and `react-dom` `^18.0.0 || ^19.0.0 || ^19.0.0-0`. Source: https://www.npmjs.com/package/@novu/react. The React quickstart wires the Inbox to React Router through `routerPush={(path) => navigate(path)}`, but with `react-router-dom` in a client-rendered Vite app, not React Router's framework mode. Source: https://docs.novu.co/platform/quickstart/react. See the probe below.

**Self-hosted Novu** is not a candidate here: the map asks for a hosted service. For the record, the single-VM option needs the API, worker, WebSocket and dashboard services plus MongoDB, Redis and S3 storage, and "some features exclusive to Novu's cloud-managed solution will not be available in a self-hosted environment". Source: https://docs.novu.co/community/self-hosting-novu/overview

## Courier

**Free tier.** The "Developer" plan is free "up to 10k / mo." "One send is one template sent to one recipient", and a template that goes out on several channels is still one send. The next plan is pay-as-you-go at $0.005 a send "including the first 10,000", reached by adding a card. Source: https://www.courier.com/pricing. Unverified, because the pricing page does not state them: whether a card is required for the Developer plan, whether Courier branding shows on the free inbox, any recipient cap, and what happens past 10,000 sends.

**React surface.** `@trycourier/courier-react` (for React 18 and later; `@trycourier/courier-react-17` for React 17) ships `CourierInbox`, `CourierInboxPopupMenu`, `CourierToast` and `CourierPreferences`. A `useCourier()` hook returns `auth`, `inbox`, `toast` and `preferences`. Source: https://www.courier.com/docs/sdk-libraries/courier-react-web. The React package wraps Courier's web components (`@trycourier/courier-ui-inbox`), which use Shadow DOM. Source: the dependency list at https://www.npmjs.com/package/@trycourier/courier-react and the `attachShadow` calls in the published `@trycourier/courier-ui-inbox` and `@trycourier/courier-ui-core` bundles.

**Restyling.** A theme object: pass `lightTheme` and `darkTheme` (`CourierInboxTheme`) and `mode`. Source: https://www.courier.com/docs/in-app/customize-the-inbox. Parts can be replaced with `renderListItem`, `renderHeader` and `renderEmptyState`, or the whole UI built on the hook. Source: https://www.courier.com/docs/in-app/build-a-custom-inbox. The docs do not say whether Tailwind classes reach inside the prebuilt component; given the Shadow DOM, assume they do not, and treat that as unverified. Content rendered through the render props is your own React.

**Real time.** Yes, without a reload, over a WebSocket, but it has to be started: `inbox.listenForUpdates()` opens the connection, and without it the inbox loads once and does not update. Source: https://www.courier.com/docs/sdk-libraries/courier-react-web

**State per person.** Each `InboxMessage` carries `read`, `opened` and `archived`. Actions are `readMessage`, `unreadMessage`, `archiveMessage`, `unarchiveMessage`, `openMessage`, `clickMessage` and `readAllMessages`; the hook exposes `totalUnreadCount`. Source: https://www.courier.com/docs/in-app/build-a-custom-inbox. Messages persist "until the user reads or archives them". Source: https://www.courier.com/docs/in-app/inbox. A message can be given an expiry (`message.expiry`), after which it drops from the feed. Source: https://www.courier.com/docs/in-app/send-to-the-inbox. Default retention is unverified.

**Node SDK.** `@trycourier/courier` (10.1.0 on npm). Source: https://www.courier.com/docs/in-app/send-to-the-inbox

```js
await client.send.message({
  message: {
    to: { user_id: 'user_123' },
    template: 'nt_01kx4h2jdafq8bk9aftxak4b40',
    data: { name: 'Sarah Bennett' },
    routing: { method: 'single', channels: ['inbox'] },
  },
});
```

Content can live on either side. The example above uses a vendor-side template. The send API also accepts inline `message.content` with a required `title` and `body` ("Syntactic sugar to provide a fast shorthand for Courier Elemental Blocks"), described as content "that will work for email, inbox, push, chat, or any channel id", and `template` is nullable. Source: https://www.courier.com/docs/reference/send/message. An inline send to the inbox channel was not run, so that combination is documented but untested.

**Browser authentication.** A JWT is the only documented model. The server calls `client.auth.issueToken({ scope: "user_id:user_123 inbox:read:messages inbox:write:events", expires_in: "2 days" })` and the client calls `signIn({ userId, jwt })`; until then "the components render empty". Omitting `expires_in` "mints a token that **never expires**", and the SDKs do not refresh tokens. Source: https://www.courier.com/docs/in-app/authenticate-users. With the fake sign-in this means minting a token for whichever user the DevUI panel selected and again on every switch. No development exemption is documented.

**Email later.** Yes; `email` is among the valid channel ids. Source: https://www.courier.com/docs/reference/send/message

**React 19 and server rendering.** `@trycourier/courier-react` 9.3.5 declares peers `react` and `react-dom` `>=18.0.0`, which admits 19. Source: https://www.npmjs.com/package/@trycourier/courier-react. The docs state that components render client-side only and need `"use client"` in Next.js 13 and later. Source: https://www.courier.com/docs/sdk-libraries/courier-react-web. See the probe below.

## MagicBell

**Free tier.** The "Builder" plan is $0 a month: "1,000 Deliveries/mo.", "1 Project", "Unlimited Team Members", "Unlimited Users", "All integrations". The next plan is $249 a month for 50,000 deliveries. The page also says "Once you hit your plan's included limit, each additional delivery will be charged per use for the rest of the month." Source: https://www.magicbell.com/pricing. Unverified, because the pricing page does not state them: whether a card is required, whether branding shows on Builder, how a "delivery" is counted for an in-app notification, and how per-use overage applies to an account on the $0 plan.

**React surface.** `@magicbell/react`, imported by subpath, ships `Provider` (`@magicbell/react/context-provider`), `Inbox` and `FloatingInbox` (a bell-triggered panel), plus `ToastContainer` and `UserPreferences`. Source: https://www.magicbell.com/docs/libraries/magicbell-react. No headless React hooks are documented for this package. An older pair, `@magicbell/magicbell-react` and `@magicbell/react-headless`, is still on npm (last published 2026-05-22) but is absent from the current docs. Sources: https://www.npmjs.com/package/@magicbell/react-headless, https://www.magicbell.com/docs. The documented way to build your own UI is the `magicbell-js` user client and its `Realtime` class. Source: https://www.magicbell.com/docs/libraries/magicbell-js

**Restyling.** Import the component stylesheet (for example `@magicbell/react/styles/floating-inbox.css`), then override CSS custom properties such as `--magicbell-bg-default` or target classes such as `.magicbell--button`. `Inbox` takes an `ItemComponent`; `FloatingInbox` takes `ButtonComponent` and `InboxComponent`. Source: https://www.magicbell.com/docs/libraries/magicbell-react

**Real time.** Yes: new notifications "appear instantly in the user's inbox without requiring a page refresh". Source: https://www.magicbell.com/docs/channels/in_app. The mechanism is a WebSocket: "The Realtime client enables real-time notification delivery through WebSocket connections." Source: https://www.magicbell.com/docs/libraries/magicbell-js

**State per person.** Notifications "track user interactions such as read, seen, and archived states", with `read_at` and `seen_at` timestamps. Source: https://www.magicbell.com/docs/primitive/notification. The user client has `markNotificationRead`, `markNotificationUnread`, `archiveNotification`, `unarchiveNotification`, `markAllNotificationsRead`, `archiveAllNotifications` and `fetchUnreadNotificationsCount`. No method for marking seen appears in the part of the reference that was read. Source: https://www.magicbell.com/docs/libraries/magicbell-js

**Node SDK.** `magicbell-js` (1.8.0 on npm). The snippet below is reduced from the documented example, which fills in more recipient fields. Source: https://www.magicbell.com/docs/libraries/magicbell-js

```ts
import { Client } from 'magicbell-js/project-client';
const client = new Client({ token: 'YOUR_TOKEN' });
await client.broadcasts.createBroadcast({
  title: 'Your title',
  content: 'Your content',
  recipients: [{ externalId: 'external_id' }],
});
```

Content is passed in the call: `title` and `content` are fields of the broadcast, with optional per-channel overrides. The page does not mention vendor-side templates.

**Browser authentication.** `Provider` has a required `token` prop, "The MagicBell User JWT". Source: https://www.magicbell.com/docs/libraries/magicbell-react. The server signs it with the project secret using HS256, with claims `user_external_id` (or `user_email`) and `api_key`; the documented example uses the `jsonwebtoken` package. Source: https://www.magicbell.com/docs/api/authentication/user. As with Courier, the fake sign-in means signing a token for the DevUI-selected user on each switch.

**Email later.** Yes; broadcasts take per-channel overrides for email, in-app, mobile push and SMS. Source: https://www.magicbell.com/docs/libraries/magicbell-js

**React 19 and server rendering.** `@magicbell/react` 1.14.0 declares no `peerDependencies` at all, so npm gives no signal either way. Source: https://www.npmjs.com/package/@magicbell/react. The docs read say nothing about React versions or server rendering. See the probe below.

## Server-rendering probe

No vendor documents React Router 8 framework mode, so this was tested rather than read. On 2026-11-21 the four React packages were installed beside `react` and `react-dom` 19.3.1 in a scratch directory, with no peer-dependency warnings from npm, and each prebuilt inbox was passed to `renderToString` in plain Node with placeholder credentials.

| Package | Version | Result under React 19.3.1 |
| --- | --- | --- |
| `@knocklabs/react` | 0.15.1 | Rendered the feed markup (1,764 characters) without throwing |
| `@novu/react` | 3.20.0 | Rendered a placeholder element without throwing; the Inbox mounts on the client |
| `@trycourier/courier-react` | 9.3.5 | Rendered an empty string without throwing, consistent with "client-side only" |
| `@magicbell/react` | 1.14.0 | Rendered the inbox markup (10,767 characters) without throwing |

What this shows: importing and server-rendering each component does not crash on the server under React 19. What it does not show: hydration without mismatch warnings, behaviour inside React Router 8's Vite server build, or anything about a live connection. Knock and MagicBell were loaded through `require`; their ES module entry points were not exercised. Those gaps belong to the prototype ticket.

## Dropped

- **SuprSend.** A real candidate and the closest to making the list. Free is 10,000 notifications a month with "No Credit Card required", but it excludes batching, digest, user preferences and webhooks, and the feed carries SuprSend branding; the next plan is $100 a month. Source: https://www.suprsend.com/pricing. It has drop-in and headless React (`@suprsend/react`, peer `react >= 16.8.0`) and tracks `seen_on`, `read_on`, `interacted_on` and `archived`. Sources: https://docs.suprsend.com/docs/inbox-react, https://docs.suprsend.com/docs/react-sdk-headless-feed. Dropped because it offers nothing the four do not, and Knock's free plan includes the preferences and batching that SuprSend's gates. If preferences turn out not to matter, it is a fair substitute for any of the four.
- **Stream (Activity Feeds).** The free "Build" plan allows 5,000 activities and 125,000 API calls with overages "Not allowed"; the next plan is $499 a month. Source: https://getstream.io/activity-feeds/pricing/. Notification feeds track `is_seen` and `is_read` and have real-time events, but the React docs describe hooks and state only, with no prebuilt inbox or bell. Sources: https://getstream.io/activity-feeds/docs/node/notification_feeds/, https://getstream.io/activity-feeds/docs/react/notification_feeds/. Dropped: it is a social activity-feed product with aggregation groups, and the inbox UI would be built by hand.
- **OneSignal.** Not a fit. "In-app messages are only available for mobile apps with the OneSignal mobile SDK installed", and they display "inside the app during an active session", so there is no web in-app channel and no persistent feed with read state. Sources: https://documentation.onesignal.com/docs/in-app-messages-setup, https://onesignal.com/pricing
- **Engagespot.** Could not be assessed. Both https://engagespot.co and https://engagespot.co/pricing returned HTTP 404 on 2026-11-21, and `@engagespot/react-component` was last published 2025-05-09. Source: https://www.npmjs.com/package/@engagespot/react-component. Dropped as unverifiable.
- **Novu self-hosted.** Not hosted, so outside the map's vendor constraint. See the note in the Novu section.

## Unverified

- **Novu:** how long Inbox notifications are kept on Free ("Inbox feed retention"), and whether "Activity feed retention: 24 hours" touches the Inbox; what overage means for a Free account with no card; whether snooze is on Free.
- **Courier:** whether a card is needed for the Developer plan; branding on the free inbox; behaviour past 10,000 sends; default message retention; whether inline content reaches the inbox channel in practice (documented, not run); whether Tailwind classes reach inside the prebuilt inbox.
- **MagicBell:** whether a card is needed; branding on Builder; how a "delivery" is counted; how per-use overage applies on the $0 plan; whether a headless React hook exists for `@magicbell/react`; whether there is a mark-as-seen call; React version support, since no peer range is declared.
- **Knock:** how long feed messages are retained; whether the "Knock branding" that Free cannot remove appears on the in-app feed component or only elsewhere.
- **All four:** hydration and behaviour inside a React Router 8 server build. Only the plain-Node probe above was run.
- **Not fetched:** https://www.magicbell.com/docs/in-app/react and https://docs.novu.co/platform/additional-resources/data-retention returned 404 (guessed URLs; the correct MagicBell page was then found). The final 93,143 characters of the `magicbell-js` reference were read only for the user client and Realtime sections.

## What the evidence favours

This section informs the vendor decision; it does not make it.

- **On the free tier alone,** Knock, Novu and Courier each give 10,000 a month and MagicBell gives 1,000. For a course project with a handful of seeded users even 1,000 is unlikely to bind, so the allowance separates the four less than the other caps do. Knock's free plan has the fewest of those: no limit on workflows, feeds or environments, and preferences and batching included. Novu's cap of 5 workflows could bind once the catalogue of Notification kinds is known. Knock and Novu are the only two that state no card is required.
- **On fitting Tailwind 4 and shadcn,** Novu is the only one whose prebuilt component accepts Tailwind classes directly. Knock and MagicBell restyle through CSS variables and class overrides, Courier through a theme object over Shadow DOM. All four allow replacing the notification row with your own component, and Knock, Novu and Courier document a React hook for a fully custom UI, which is the route that sits most naturally beside shadcn.
- **On the fake sign-in,** Knock and Novu can run with no signed token at all in development (public key plus user id), which is the least friction for a DevUI user switch. Courier and MagicBell need the server to sign a token for the selected user on every switch; that is a small loader, not a blocker.
- **On where the wording lives,** Knock and Novu keep content in vendor-side templates and take variables in the call. MagicBell takes the text in the call. Courier supports both. This bears on the map's open questions about wording, local development without a vendor key, and whether Cadence keeps its own record: inline content keeps the text in the repo; vendor-side templates put it in a dashboard.
- **On the definition of a Notification** ("stays until read"), Knock, Novu and MagicBell track seen separately from read, and all four track read and archived. The one open risk is Novu's unverified Inbox retention on Free.
- **Taken together,** the evidence puts Knock and Novu ahead of Courier and MagicBell for this project, with the choice between those two turning on things this ticket could not settle: Novu's Inbox retention and workflow cap against Knock's lack of Tailwind class props on its prebuilt feed. Courier is the pick if inline content and vendor templates are both wanted; MagicBell if the simplest inline send matters more than the allowance.
