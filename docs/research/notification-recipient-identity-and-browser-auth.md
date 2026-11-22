# How each notification service identifies recipients and authenticates the browser

Research for [issue #27](https://github.com/rampoldz/cohort-005-project/issues/27). Deepens the vendor survey from issue #26 (`docs/research/in-app-notification-vendors.md` on branch `research/in-app-notification-vendors`).

- **Read on:** 2026-11-21.
- **Sources:** each vendor's own documentation, its own SDK source on GitHub, and the published npm package. Every claim carries its source URL.
- **Three kinds of statement,** kept apart throughout:
  - **Docs** — stated in the vendor's documentation.
  - **Source** — not in the docs, but read in the vendor's SDK source code (main branch on the read date, which may be ahead of the published npm version).
  - **Inferred** — my conclusion from the two above. Nothing here was run against a live account.
- **"Unverified"** means the vendor's pages did not state it or the page could not be fetched. Nothing unverified is filled in from memory.

## Cadence facts the findings are stated against

- A user is a row in `users` (`app/db/schema.ts`): `id` is an auto-increment **integer**; also `name`, unique `email`, `role`, nullable `avatarUrl`, `bio`, `createdAt`. Rows come from `scripts/seed.ts`.
- The current user is a number in the `cadence_session` cookie (`app/lib/session.ts`, `getCurrentUserId` returns `number | null`). There can be **no current user** (`null`).
- The DevUI panel (`app/components/dev-ui.tsx`) switches users with a React Router `<Form method="post">` to `/api/switch-user`, which sets the cookie and redirects back (`app/routes/api.switch-user.ts`). That is a client-side navigation: loaders re-run, the document is not reloaded, and `app/routes/layout.app.tsx` stays mounted with new `loaderData`. So any notification provider placed in that layout sees its **props change in place**; it is not remounted unless given a `key`.
- The loader that already returns `currentUser` is the one in `app/routes/layout.app.tsx`. "The loader" below means that one (or `root.tsx` if the feed is placed higher).
- All four services take recipient ids as **strings**, so the recipient id is `String(user.id)`: `"1"`, `"2"`, … The same string must be used on the server when sending and in the browser when reading. Bare seed integers are identical across every developer's database, which matters if two people share one vendor environment (inferred; a prefix such as `cadence-user-1` would not fix that either).

## Comparison

| | Knock | Novu (cloud) | Courier | MagicBell |
| --- | --- | --- | --- | --- |
| Recipient created | Inline on trigger if passed as an object `{ id }`; a bare string must already be identified. The browser provider also identifies the user by default | Just in time, on trigger or when the Inbox first loads with an unknown id | Inbox: "Authenticating a user registers them". A send does not create a profile | Upsert from the notification request (docs); from first JWT use: unverified |
| Minimum record | `id` | `subscriberId` | `user_id` (any string) | `external_id` or `email` |
| Browser credential | Public API key + user id; plus RS256 user JWT when enhanced security is on | Application identifier + subscriber id; plus HMAC-SHA256 hash when the toggle is on | JWT from `issue-token`, always | HS256 user JWT, always |
| Signed mode | Optional, off by default, set per environment | Optional, toggle on the In-App integration | Mandatory, no exemption documented | Mandatory (`token` is a required prop) |
| Secret the server needs to sign | `KNOCK_SIGNING_KEY` (RSA private key), not the API secret | Novu secret key | Courier API key (network call) | Project secret key + API key (local signing) |
| Loader hands the page | `apiKey`, `feedId`, `userId`, optionally `userToken` | `applicationIdentifier`, `subscriberId`, optionally `subscriberHash` | `userId`, `jwt` | `token` |
| Token lifetime | Default 3600 s (`expiresInSeconds`); refresh hook `onUserTokenExpiring` | The hash does not expire | `expires_in` required by the API reference; SDK does not refresh | Docs examples use `1y`; no refresh mechanism documented |
| User changes mid-session | Provider re-authenticates in place and the feed subtree remounts by key (source) | Provider builds a new client when the subscriber changes (source) | Call `signIn` again; it signs the previous user out first (source) | New token gives a new client, socket and store (source); old socket cleanup unverified |
| Logout call | `knock.logout()` in the client; `enabled={false}` on the provider (source) | None documented | `signOut()` | None documented |
| Environments on free tier | Production, plus development once enabled; keys per environment | Development and Production only; keys per environment | Production and Test by default; each key belongs to one environment | None documented; free plan is "1 Project" |

## Knock

**1. Recipients.**

- Docs: a user needs only `id` ("the only required property"). Optional: `email`, `name`, `avatar`, `phone_number`, `timezone`. The id is at most 256 characters, cannot contain `/` or `#`, and cannot be changed once set. Source: https://docs.knock.app/concepts/users
- Docs: a trigger's recipients can be "A string indicating a user that you have previously identified to Knock", an object reference, or "A complete `Recipient`, to be identified inline during the workflow execution." Source: https://docs.knock.app/send-notifications/triggering-workflows/api
- Docs: inline identification works on "any endpoint that accepts a list of recipients"; "Knock guarantees that recipients are identified before executing any other action", described as "lazy recipient creation". The correct inline shape is `"recipients": [{ "id": "user-123" }]`; the page calls passing bare id strings for this purpose "a common mistake". Source: https://docs.knock.app/managing-recipients/identifying-recipients
- Docs: identifying ahead of time is an upsert: "Create or update a user with the provided identification data", merging properties. Source: https://docs.knock.app/api-reference/users/update
- Docs + source: the **browser** also identifies the user. `KnockProvider` has `identificationStrategy`, default inline; `skip` turns it off. Source: https://docs.knock.app/in-app-ui/react/sdk/components/knock-provider. In the client, `authenticate()` given an object with an `id` calls `user.identify` with the remaining properties. Source: https://github.com/knocklabs/javascript/blob/main/packages/client/src/knock.ts
- Unverified: what happens when a bare string id that was never identified is passed to a trigger. The docs only describe the string form as a "previously identified" user.
- For Cadence (inferred): pass `recipients: [{ id: String(user.id), name: user.name, email: user.email }]` on every trigger and no separate sync step is needed. Whether the seed script should also identify users is a design choice, not a requirement.

**2. Browser authentication.**

- Docs: "Enhanced security mode is off by default, so you can build and test your in-app integration with only your public key." "Without enhanced security mode, a request with your public key can act as any user." Production environments "should enable enhanced security mode", and the page advises to "keep enhanced security mode off in your development environment", which is the evidence that the setting is per environment. Source: https://docs.knock.app/in-app-ui/security-and-authentication
- Docs: with it on, the browser must send a user token: an RS256 JWT signed with the private **signing key** from Platform > API keys, with `sub` (required, the user id) and `iat`/`exp` (recommended); optional `grants`. Same source.
- The page states no plan restriction on enhanced security mode. Whether it is available on Free is therefore unverified in the strict sense, though nothing says otherwise.
- Unverified: where in the dashboard the toggle sits; the page read does not say.

**3. What the loader hands the page.**

- Without enhanced security: `{ knockPublicKey, knockFeedId, userId: String(currentUser.id) }`. `apiKey` is "Your public API key from the Knock dashboard"; `feedId` is the in-app feed channel id. Sources: https://docs.knock.app/in-app-ui/react/sdk/components/knock-provider, https://docs.knock.app/in-app-ui/react/feed
- With enhanced security: add `userToken`. Docs give `import { signUserToken } from "@knocklabs/node/lib/tokenSigner"` and `await signUserToken(userId, { signingKey, expiresInSeconds })`; `signingKey` defaults to the `KNOCK_SIGNING_KEY` environment variable and `expiresInSeconds` to 3600. Source: https://docs.knock.app/in-app-ui/security-and-authentication. The SDK README imports it from the package root instead (`import { signUserToken } from '@knocklabs/node'`). Source: https://github.com/knocklabs/knock-node/blob/main/README.md. Which import path works in 1.41.1 was not run.
- Source: `signUserToken(userId: string, options?)` is local signing with `jose` (no network call), and the key may be PEM or base64-encoded PEM. Payload is `sub`, `grants`, `iat`, `exp`. Source: https://github.com/knocklabs/knock-node/blob/main/src/lib/tokenSigner.ts
- Docs: on lifetime, "Generally, it's advisable to set the token expiration to be equal to your session token expiration"; otherwise use a short-lived token and the `onUserTokenExpiring` callback, "which will be invoked before the user token expires". Source: https://docs.knock.app/in-app-ui/security-and-authentication. Source code: the callback fires `timeBeforeExpirationInMs` before `exp`, default 30,000 ms, and its returned string is used to re-authenticate. Source: https://github.com/knocklabs/javascript/blob/main/packages/client/src/knock.ts
- Documented provider shape: `<KnockProvider apiKey={...} user={{ id: currentUser.id }} userToken={...}>` wrapping `<KnockFeedProvider feedId={...}>`. Passing the user id as a bare string is deprecated in favour of `{ id }` (source: `useAuthenticatedKnockClient.ts`, below).
- Cadence's session cookie has no expiry of its own, so "match the session" gives no number; a refresh callback hitting a small resource route is the documented alternative (inferred).

**4. User changes mid-session.**

- The docs page for the provider does not describe changing users. It does document `enabled`: when `false`, "the Knock client stays idle"; turning it back to `false` disconnects and clears data; and `useKnockAuthState` reports auth changes. Source: https://docs.knock.app/in-app-ui/react/sdk/components/knock-provider
- Docs: "Calling `authenticate` again with a new token restarts the real-time connection." Source: https://docs.knock.app/in-app-ui/security-and-authentication
- Source: `useAuthenticatedKnockClient` memoises on `[apiKey, enabled, user, userToken, options]`. If a client is already authenticated and the user id or token differs, it re-authenticates the existing instance in place; its comment adds "A userId change still remounts the feed subtree downstream because `feedProviderKey` includes the userId." Source: https://github.com/knocklabs/javascript/blob/main/packages/react-core/src/modules/core/hooks/useAuthenticatedKnockClient.ts. `KnockFeedProvider` sets `key={feedProviderKey(knock.userId, feedId, defaultFeedOptions)}` on its context provider. Source: https://github.com/knocklabs/javascript/blob/main/packages/react-core/src/modules/feed/context/KnockFeedProvider.tsx
- Source: in the client, changed credentials make `authenticate()` tear down feed instances and the socket, build a new API client, and reinitialise feed connections. There is a `logout()` method that tears down connections and clears credentials. Source: https://github.com/knocklabs/javascript/blob/main/packages/client/src/knock.ts
- Inferred for Cadence: changing the `user` and `userToken` props together is enough; no manual `key` is needed. For "no current user", render the provider with `enabled={false}` or not at all. Because the source read was `main`, whether `enabled`, `logout()` and the keyed remount are all in the published `@knocklabs/react` 0.15.1 is unverified.

**5. Environments.**

- Docs: "Your Knock account starts with a single environment: production", and development "is added when you enable environments." "Each environment has its own set of API keys"; a new environment gets "A new public and secret key pair." Users, messages, tenants, objects and logs are per environment and "will never be shared between environments"; "Each environment has a separate, isolated set of users." Workflows are versioned content promoted between environments; channel provider credentials are not copied. Sources: https://docs.knock.app/concepts/environments, https://docs.knock.app/concepts/users
- From the prior research: the Free plan lists unlimited environments. Source: https://knock.app/pricing
- Unverified: whether the signing key is one per environment or one per account; the environments page speaks only of a "public and secret key pair".

## Novu (cloud)

**1. Recipients.**

- Docs: "`subscriberId` is required and must be unique in that environment." "You can use any unique ID as subscriberId", and the page recommends the application's internal user id. Optional: `firstName`, `lastName`, `email`, `phone`, `locale`, a `data` object. Source: https://docs.novu.co/platform/concepts/subscribers
- Docs: subscribers can be created just in time, "Novu uses the information provided in the workflow trigger to create the subscriber on the fly", updating stored data if the subscriber exists; or ahead of time with `novu.subscribers.create({ subscriberId, ... })`; or in bulk, up to 500. Same source.
- Docs: the Inbox creates them too: "If you pass a `subscriberId` that does not exist yet, Novu will automatically create a new subscriber with that ID." Source: https://docs.novu.co/platform/quickstart/react
- Docs: in the trigger call `to` may be a string ("Unique identifier of a subscriber in your systems", minimum length 1) or an object whose only required property is `subscriberId`. Source: https://docs.novu.co/api-reference/events/trigger-event. The reference does not itself say that the bare-string form creates an unknown subscriber; the subscribers page's just-in-time example uses the object form.
- For Cadence (inferred): `to: { subscriberId: String(user.id), firstName, email }` on each trigger; no sync step.

**2. Browser authentication.**

- Docs: by default the Inbox needs only `applicationIdentifier` and the subscriber id. The risk is stated: "Without additional security, a malicious actor could potentially guess another subscriber's `subscriberId`". Source: https://docs.novu.co/platform/inbox/prepare-for-production
- Docs: the signed mode is an HMAC, switched on by the "Security HMAC encryption" toggle on the Novu In-App provider in the Integrations Store, described for "your production environment". Once on, "If HMAC encryption is active in In-App provider settings and `subscriberHash` is not provided, the Inbox will not load." The page states no plan restriction. Same source.
- Docs: integrations are per environment. Source: https://docs.novu.co/platform/concepts/environments. Inferred: the HMAC toggle is therefore per environment, so it can be off in Development and on in Production. The docs do not say this in one sentence.
- Unverified: the docs never state the toggle's default. That it is off by default is inferred from the quickstart working without a hash.
- Docs: there is also a keyless mode with no application identifier at all: "This is only for testing, the data is temporary (expires in 24h) and not tied to real subscribers." Source: https://docs.novu.co/platform/inbox/setup-inbox. Not usable for Cadence, since notifications must reach a specific user.
- Docs: one side effect of running unsigned: without `subscriberHash`, a `subscriber` object passed to the Inbox does not update an existing subscriber's profile. Source: https://docs.novu.co/platform/inbox/prepare-for-production

**3. What the loader hands the page.**

- Unsigned: `{ novuApplicationIdentifier, subscriberId: String(currentUser.id) }`. The application identifier "can be found in the Novu Dashboard under the API keys page". Source: https://docs.novu.co/platform/quickstart/react. It is "Different for each environment" and safe to expose. Source: https://docs.novu.co/platform/concepts/environments
- Signed: add `subscriberHash`, computed with Node's built-in crypto, no Novu SDK call: `createHmac('sha256', novuSecretKey).update(subscriberId).digest('hex')`, i.e. "`HMAC-SHA256(secretKey, subscriberId)`" as "a lowercase hex string". The key is the environment's secret key, the same one the server uses to trigger. Source: https://docs.novu.co/platform/inbox/prepare-for-production
- There is no token and so no lifetime or refresh: the hash is a fixed function of the secret key and the subscriber id (inferred from the formula). It changes only if the secret key is rotated.
- Documented component shape: `<Inbox applicationIdentifier="..." subscriberId="..." subscriberHash="..." />`. Both `subscriberId` (string) and `subscriber` (`string | Subscriber`) are in the props table. Source: https://docs.novu.co/platform/sdks/react

**4. User changes mid-session.**

- The docs say nothing about a changing subscriber, and document no logout or reset call. Sources: https://docs.novu.co/platform/sdks/react, https://docs.novu.co/platform/inbox/setup-inbox
- Source: the provider builds its client in a `useMemo` whose dependencies include the application identifier, `subscriberHash` and the subscriber object (itself memoised on `subscriberId`), so a changed subscriber id or hash constructs a `new Novu(...)`. Source: https://github.com/novuhq/novu/blob/next/packages/react/src/hooks/NovuProvider.tsx. `Inbox` wraps itself in that provider when none is present, and `NovuUI` pushes the new client and options into the mounted UI with `novuUI.updateOptions(...)` and `novuUI.updateNovu(novu)` in an effect. Sources: https://github.com/novuhq/novu/blob/next/packages/react/src/components/Inbox.tsx, https://github.com/novuhq/novu/blob/next/packages/react/src/components/NovuUI.tsx
- Inferred for Cadence: changing the props should switch the feed without a remount. What happens to the previous client's WebSocket is unverified: no teardown of the old `Novu` instance appears in the provider. Adding `key={subscriberId}` to the Inbox would force a clean remount and costs nothing; whether it is needed is a question for the prototype.
- With no current user there is a trap (source): an empty subscriber id is how the SDK selects keyless mode ("missing - keyless subscriber, the api will generate a subscriberId"). Source: https://github.com/novuhq/novu/blob/next/packages/js/src/utils/build-subscriber.ts. So do not render the Inbox when `currentUser` is `null` (inferred).

**5. Environments.**

- Docs: "When you create a Novu account, you are provided with a development and production environment by default." "The Free plan includes Development and Production only"; custom environments are "only available on Team and Enterprise plans." Source: https://docs.novu.co/platform/concepts/environments
- Docs: "Data in one environment has no connection to data in another": API keys, integrations, subscribers, topics, webhooks and the activity feed are per environment. The application identifier and the secret key are each "Different for each environment". Workflows are edited in Development and published to Production; Production is view-only. Same source.

## Courier

**1. Recipients.**

- Docs: "The `user_id` is yours to choose"; Courier "accepts any string". A send does not create a profile: "A send looks up an existing profile, it doesn't persist one from the `to` object." For the Inbox specifically: "Authenticating a user registers them." Profiles are created with `client.profiles.create("user_123", { profile: { email } })`, which merges. Source: https://www.courier.com/docs/platform/users/users-overview
- Docs: the inbox send addresses `to: { user_id }`, and the requirement given is that the "recipient `user_id` matches the `userId` you signed in with." Source: https://www.courier.com/docs/in-app/send-to-the-inbox
- Unverified: whether an inbox send to a `user_id` that has no profile and has never signed in is stored and shown when that user first signs in. The docs read do not address it. This matters for Cadence (a notification for a user nobody has switched to yet) and should be tested in the prototype.
- The minimum record is not stated; from the above it is the `user_id` string alone (inferred).

**2. Browser authentication.**

- Docs: "Courier authenticates with a **JWT** that your backend mints with your Courier API key, never in client code." Source: https://www.courier.com/docs/sdk-libraries/courier-react-web. The authentication page describes only the JWT model: no public-key-only mode and no HMAC mode. Until `signIn` runs, "the components render empty." Source: https://www.courier.com/docs/in-app/authenticate-users
- So the signed mode is mandatory, on every plan and in every environment; no development exemption is documented. This confirms the prior research.

**3. What the loader hands the page.**

- `{ courierUserId: String(currentUser.id), courierJwt }`. No public key or client key is involved: `signIn({ userId, jwt })`, with optional `tenantId`, `apiUrls`, `showLogs`. Sources: https://www.courier.com/docs/in-app/authenticate-users, https://www.courier.com/docs/sdk-libraries/courier-react-web
- Docs: the token is minted by a **network call**, not signed locally: `POST https://api.courier.com/auth/issue-token` with the API key as bearer, or in Node:

  ```js
  const { token } = await client.auth.issueToken({
    scope: "user_id:1 inbox:read:messages inbox:write:events",
    expires_in: "2 days",
  });
  ```

  The scope must contain `user_id:<id>`, plus `inbox:read:messages` and `inbox:write:events` for the Inbox; add `read:preferences write:preferences` for the preference centre. The `user_id` in the scope must match the `userId` given to `signIn`. Source: https://www.courier.com/docs/in-app/authenticate-users
- Docs disagree on `expires_in`. The guide says omitting it "mints a token that never expires". The API reference marks it required and lists formats such as "2 hours", "1d", "10h", "1m", "5s", "1y". Sources: https://www.courier.com/docs/in-app/authenticate-users, https://www.courier.com/docs/reference/auth/issue-token. Always set it.
- Docs: "The SDKs do not refresh tokens"; before expiry, mint a new JWT and call `signIn` again. Source: https://www.courier.com/docs/in-app/authenticate-users
- Inferred for Cadence: the loader makes one outbound HTTPS call to Courier per run unless the token is cached. The layout loader re-runs on every navigation and after every action, so cache the token per user id (in memory or in the session) or serve it from a separate resource route.

**4. User changes mid-session.**

- Docs: call `signOut` on logout; it "clears stored credentials and disconnects the real-time socket", and auth listeners fire on sign-in and sign-out. Call `signIn` again "only when the user changes or the token expires" (written of the mobile SDKs). Source: https://www.courier.com/docs/in-app/authenticate-users. The React page does not say what a second `signIn` with a different user does. Source: https://www.courier.com/docs/sdk-libraries/courier-react-web
- Source: there is no provider and no props; `Courier.shared` is a module-level singleton. `signIn` checks for an existing client, warns "Sign in called but there is already a user signed in. Signing out the current user.", calls `signOut()` (which closes the inbox socket), then creates the new client and notifies auth listeners. Source: https://github.com/trycourier/courier-web/blob/main/@trycourier/courier-js/src/shared/courier.ts. The inbox web component listens for that and calls `refresh()` when a user id is present. Source: https://github.com/trycourier/courier-web/blob/main/@trycourier/courier-ui-inbox/src/components/courier-inbox.ts
- Inferred for Cadence: an effect keyed on `[userId, jwt]` that calls `auth.signIn(...)`, and `auth.signOut()` when `currentUser` is `null`, covers the DevUI switch. With a custom UI built on the hook, `inbox.listenForUpdates()` must be called again after each sign-in, since the previous socket was closed (docs give the order `signIn`, `registerFeeds`, `listenForUpdates`, `load`). Whether the prebuilt `CourierInbox` reopens the socket itself after a re-sign-in is unverified.

**5. Environments.**

- Docs: "Every workspace starts with Production and Test environments, and you can add up to 18 custom ones, for 20 in total." "Each API key belongs to one environment." An environment isolates "Config and data within a workspace (templates, integrations, keys, logs)". Templates move with a Migrate template flow; provider integrations are not copied. Source: https://www.courier.com/docs/workspaces/overview
- Docs: "a Test key only reads and writes Test data." Keys are managed under Platform → API Keys. Source: https://www.courier.com/docs/reference/api-overview
- Docs: "Sends from Test and custom environments count the same as Production" against the allowance. Source: https://www.courier.com/pricing
- There is no browser-side key at all, so nothing public is environment-scoped; a JWT belongs to the environment of the API key that issued it ("Use the key for the environment whose tokens you're issuing"). Source: https://www.courier.com/docs/in-app/authenticate-users
- Unverified: the pricing page does not list environments under the free Developer plan. "Every workspace starts with" both is the only evidence that Test is available on it. Also unverified: whether user profiles and inbox messages are isolated per environment; the workspace page lists "user profiles" under the workspace layer, while the API overview says a Test key reads and writes only Test data.

## MagicBell

**1. Recipients.**

- Docs: "MagicBell accepts two types of unique identifiers: **emails** and **external IDs**", and external ids are "our preferred identifier for production usage". "External IDs always take precedence over email." An external id "once set for a user, it cannot be changed or unset." And, directly relevant: "If you use an integer to identify users, remember to cast it to a string before sending it to MagicBell." Source: https://www.magicbell.com/docs/primitive/user
- Docs: creation is an upsert, "a new user will be created" if none matches, and user data can ride along with a send: "You can do this in the request to create notifications." Same source.
- The minimum record is one identifier; the page's example creates a user from an email alone. Same source.
- Unverified: the broadcast reference does not itself say that an unknown recipient is created. Source: https://www.magicbell.com/docs/primitive/broadcast. Also unverified: whether presenting a JWT for an external id that MagicBell has never seen creates the user or fails.
- For Cadence (inferred): `recipients: [{ externalId: String(user.id) }]`, and pick external ids rather than email, as the docs advise against mixing the two.

**2. Browser authentication.**

- Docs: the React `Provider` has one required prop, `token`, "The MagicBell User JWT". Source: https://www.magicbell.com/docs/libraries/magicbell-react. "User JWTs must be **signed with your project's Secret Key** using the `HS256` algorithm", and "The JWT should be generated by your backend and provided to the frontend." Source: https://www.magicbell.com/docs/api/authentication/user
- So the signed mode is mandatory; no unsigned mode is documented for the current API, and no development exemption. This confirms the prior research.
- Note: the older v1 REST API authenticated user calls with an API key, a user external id header and a user HMAC header. That scheme appears in the v1 reference only and is absent from the current authentication pages. Sources: https://www.magicbell.com/docs/rest-api/reference (seen through a search result summary, not read in full), https://www.magicbell.com/docs/api/authentication

**3. What the loader hands the page.**

- `{ magicbellToken }` and nothing else: the user identity and the project's API key are inside the token. Claims: `user_external_id` ("Required when no `user_email` is provided"), `user_email`, and `api_key` ("The API key for your MagicBell project"). Source: https://www.magicbell.com/docs/api/authentication/user
- Docs: signing is local, with the `jsonwebtoken` package rather than a MagicBell SDK call: `jwt.sign(payload, secret, { algorithm: 'HS256', expiresIn: '1y' })`. The secret key "can be obtained from the User Auth page on our Dashboard." Same source.
- Lifetime: the docs give no recommendation; both of their samples use one year. No refresh mechanism is documented. Same source.
- Two server secrets are in play (inferred from the two auth pages): the project secret key signs user JWTs, while sending uses a separate project JWT, "obtained and managed via our dashboard". Source: https://www.magicbell.com/docs/api/authentication

**4. User changes mid-session.**

- The docs cover none of token change, expiry, logout or switching users. Source: https://www.magicbell.com/docs/libraries/magicbell-react
- Source (the published `@magicbell/react` 1.14.0 package, `src/context-provider.tsx` and `src/internal/context/context.ts`): the provider calls `createMagicBellContext({ token })` on every render, and that function memoises the API client, the realtime socket store and the notification store in a module-level LRU cache keyed on the token. A new token therefore yields a new client, socket and store; the same token reuses them. Source: https://www.npmjs.com/package/@magicbell/react
- Inferred for Cadence: changing the `token` prop switches the feed with no remount. Unverified: whether the previous user's WebSocket is closed. A search of `realtime-store.ts` for a disconnect or close call found none, and the cache keeps up to 50 entries, so switching back and forth in the DevUI may leave old sockets open until reload. Check in the prototype.
- One consequence of the cache key (inferred): if the loader signs a fresh token on every run, `iat` changes, the token string changes, and the provider builds a new client and socket on every navigation. Sign once per user and reuse the string (cache it, or pin `iat`).
- With no current user there is no token, and `token` is required: do not render the provider (inferred).

**5. Environments.**

- Not documented. The authentication pages speak only of "your project" and never mention development, staging or production. Sources: https://www.magicbell.com/docs/api/authentication, https://www.magicbell.com/docs/api/authentication/user
- From the prior research: the free Builder plan is "1 Project". Source: https://www.magicbell.com/pricing
- Inferred: on the free plan there is one project, hence one API key and secret key shared by local development and anything deployed. Whether a project has environments inside it is unverified.

## What each implies for the DevUI user switch

All inferred from the findings above; none was run.

- **Knock.** Least work. The loader adds `knockPublicKey`, `knockFeedId` and the user id string; the layout renders `<KnockProvider user={{ id }}>`. Switching users changes a prop and the SDK re-authenticates and remounts the feed by key. No server secret is needed in the browser path while enhanced security stays off in development. Because the provider identifies the user inline from the browser, a user appears in Knock the first time anyone switches to them, even before any trigger.
- **Novu.** Equally little. The loader adds `novuApplicationIdentifier` and the subscriber id string; a changed prop builds a new client. If the HMAC toggle is turned on later, the loader adds one `createHmac` line with no network call and nothing to refresh. Add `key={subscriberId}` if the prototype shows stale state. Do not render the Inbox with no current user, or it falls into keyless mode.
- **Courier.** Most work. Each switch needs a JWT minted by an HTTPS call to Courier with the secret API key, an effect that calls `signIn` (and `signOut` for no user), and a re-opened socket. Tokens should be cached per user and given an expiry. There is no way to run unsigned in development, so local development always needs a Courier API key and network access.
- **MagicBell.** In between. Each switch needs a JWT, but it is signed locally with `jsonwebtoken`, so no network call. Passing the new token re-points the provider. The token must be stable across loader runs or the socket is rebuilt on every navigation. Local development always needs the project secret key.

For all four, the recipient id is `String(user.id)`, and seeded ids are the same small integers on every machine. Two developers pointing at the same vendor environment would read each other's notifications for "user 1". Knock, Novu and Courier offer a second environment on the free tier to separate deployed from local; none of them separates two local databases.

## Unverified

- **Knock:** behaviour when a never-identified bare string id is passed to a trigger; where the enhanced security toggle sits in the dashboard and an explicit statement that it is per environment (only implied by "keep enhanced security mode off in your development environment"); any plan gating of enhanced security (none stated); whether the signing key is per environment; which `signUserToken` import path works in `@knocklabs/node` 1.41.1 (docs and README differ); whether the `main`-branch behaviours read in source (`enabled`, `logout()`, keyed feed remount) are all in `@knocklabs/react` 0.15.1.
- **Novu:** the HMAC toggle's default state and an explicit statement that it is per environment; whether a bare-string `to` creates an unknown subscriber (the object form is documented to); whether the previous client's socket is closed when the subscriber changes. The pages `https://docs.novu.co/platform/inbox/keyless-mode`, `.../inbox/configuration/hmac-encryption` and `.../inbox/configuration/subscriber-management` were guessed URLs and returned 404.
- **Courier:** whether an inbox message sent to a user who has no profile and has never signed in is kept and shown on first sign-in; whether the Test environment is included on the free Developer plan (implied, not listed on the pricing page); whether profiles and inbox messages are isolated per environment; whether the prebuilt `CourierInbox` reopens its socket after a second `signIn`; whether `expires_in` is truly optional (guide) or required (reference). `https://www.courier.com/docs/platform/workspaces/environments-and-api-keys` was a guessed URL and returned 404.
- **MagicBell:** whether a broadcast to an unknown external id creates the user (the user page implies it, the broadcast page is silent); whether a JWT for a never-seen external id works; any recommended token lifetime; whether old sockets are closed when the token changes; whether projects have environments. The Users section of https://www.magicbell.com/docs/api/reference ("Save a user") was not reached; the page is long and the part read ended before it.
- **All four:** every "what happens on a user switch" statement comes from reading source, not from running it.

## Corrections to the prior research (issue #26)

The summary-level findings on browser authentication hold for all four. Refinements:

- **Knock.** The prior note says "a recipient can be created in the same call". True, but only when the recipient is passed as an object; its code sample passes a bare string (`recipients: ['dnedry']`), which the docs define as "a user that you have previously identified". Also new: the React provider identifies the user from the browser by default (`identificationStrategy`), and the token signer signs with a dedicated signing key, not the secret API key.
- **Novu.** "A subscriber that does not exist is created" holds for both the trigger and the Inbox itself. New: the unsigned mode has a cost, in that a `subscriber` object passed to the Inbox will not update an existing profile without `subscriberHash`; and an empty subscriber id silently selects keyless mode.
- **Courier.** "Omitting `expires_in` mints a token that never expires" is what the guide says, but the API reference marks `expires_in` required. The prior note's "minting a token ... on every switch" understates it slightly: minting is a network call to Courier, not local signing, and a profile is not needed first because "Authenticating a user registers them".
- **MagicBell.** No correction. New: the docs say to cast integer ids to strings; the docs' sample tokens last a year; and the provider caches its client by token string, so the token must be stable between loader runs.
