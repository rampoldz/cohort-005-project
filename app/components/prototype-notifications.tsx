// PROTOTYPE — throwaway. Wayfinder ticket #31 "What does the Notification surface look like?"
//
// Four variants of the Notification surface, mounted in the real layout
// (app/routes/layout.app.tsx) and switchable with ?variant=A|B|C|D or the
// floating bar at the bottom of the screen:
//
//   A  Knock's own bell + popover, in the sidebar header      (Knock's component, Knock's styling)
//   B  A "Notifications" sidebar row opening a full-height panel (built on Knock's client)
//   C  A "Notifications" sidebar row leading to a full page       (built on Knock's client)
//   D  A bell by the person's name, small popover, dot not count  (built on Knock's client)
//
// Every variant reads the real Knock feed for the user picked in the DevUI panel.
// Clicking a Notification marks it read and follows its link: a placeholder, since
// where it leads and when it counts as read is a later ticket.
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Link,
  NavLink,
  useFetcher,
  useNavigate,
  useSearchParams,
} from "react-router";
import Knock, { type Feed, type FeedItem } from "@knocklabs/client";
import {
  KnockFeedProvider,
  KnockProvider,
  NotificationFeedPopover,
  NotificationIconButton,
  useNotificationStore,
} from "@knocklabs/react";
import "@knocklabs/react/dist/index.css";
import { Bell, ChevronLeft, ChevronRight, X } from "lucide-react";
import { cn } from "~/lib/utils";

export const VARIANTS = {
  A: "Knock's own popover",
  B: "Sidebar row + side panel",
  C: "Sidebar row + full page",
  D: "Bell by your name, dot only",
} as const;
export type Variant = keyof typeof VARIANTS;
const KEYS = Object.keys(VARIANTS) as Variant[];
const STORAGE_KEY = "prototype-notifications-variant";

interface Ctx {
  variant: Variant;
  setVariant: (v: Variant) => void;
  feed: Feed | null;
  knockConfig: { publicKey: string | null; feedId: string | null };
  userId: number | null;
}
const PrototypeCtx = createContext<Ctx | null>(null);
function useProto() {
  const ctx = useContext(PrototypeCtx);
  if (!ctx) throw new Error("PrototypeNotificationsProvider missing");
  return ctx;
}

// The variant survives navigation (links drop ?variant=) by also living in localStorage.
export function PrototypeNotificationsProvider({
  knockConfig,
  userId,
  children,
}: {
  knockConfig: Ctx["knockConfig"];
  userId: number | null;
  children: ReactNode;
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const param = searchParams.get("variant") as Variant | null;
  const [stored, setStored] = useState<Variant>("A");
  useEffect(() => {
    const s = localStorage.getItem(STORAGE_KEY) as Variant | null;
    if (s && KEYS.includes(s)) setStored(s);
  }, []);
  const variant = param && KEYS.includes(param) ? param : stored;
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, variant);
    setStored(variant);
  }, [variant]);

  function setVariant(v: Variant) {
    setSearchParams(
      (prev) => {
        prev.set("variant", v);
        return prev;
      },
      { replace: true }
    );
  }

  // One Knock client and feed for the own-built variants (B, C, D), made in the
  // browser only and remade when the DevUI switches user.
  const [feed, setFeed] = useState<Feed | null>(null);
  useEffect(() => {
    if (!knockConfig.publicKey || !knockConfig.feedId || !userId) {
      setFeed(null);
      return;
    }
    const knock = new Knock(knockConfig.publicKey);
    knock.authenticate(String(userId));
    const f = knock.feeds.initialize(knockConfig.feedId, { page_size: 30 });
    f.listenForUpdates();
    f.fetch();
    setFeed(f);
    return () => {
      f.dispose();
      knock.teardown();
    };
  }, [knockConfig.publicKey, knockConfig.feedId, userId]);

  return (
    <PrototypeCtx.Provider
      value={{ variant, setVariant, feed, knockConfig, userId }}
    >
      {children}
    </PrototypeCtx.Provider>
  );
}

// ─── Shared by the own-built variants ───

function timeAgo(iso: string) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function bodyHtml(item: FeedItem) {
  const block = item.blocks.find((b) => b.type !== "button_set");
  return block && "rendered" in block ? block.rendered : "";
}

function useOpenItem(feed: Feed, after?: () => void) {
  const navigate = useNavigate();
  return (item: FeedItem) => {
    if (!item.read_at) feed.markAsRead(item);
    after?.();
    const url = (item.data as { url?: string } | null)?.url;
    if (url) navigate(url);
  };
}

function Row({
  item,
  onOpen,
  roomy = false,
}: {
  item: FeedItem;
  onOpen: (item: FeedItem) => void;
  roomy?: boolean;
}) {
  const unread = !item.read_at;
  return (
    <button
      onClick={() => onOpen(item)}
      className={cn(
        "flex w-full items-start gap-3 text-left transition-colors hover:bg-accent",
        roomy ? "px-5 py-4" : "px-4 py-3"
      )}
    >
      <span
        className={cn(
          "mt-1.5 size-2 shrink-0 rounded-full",
          unread ? "bg-blue-500" : "bg-transparent"
        )}
      />
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block text-sm [&_p]:m-0",
            unread ? "font-medium text-foreground" : "text-muted-foreground"
          )}
          dangerouslySetInnerHTML={{ __html: bodyHtml(item) }}
        />
        <span className="mt-0.5 block text-xs text-muted-foreground">
          {timeAgo(item.inserted_at)}
        </span>
      </span>
    </button>
  );
}

function Empty({ text = "Nothing new." }: { text?: string }) {
  return (
    <div className="p-8 text-center text-sm text-muted-foreground">{text}</div>
  );
}

const navRow =
  "flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors";
const navIdle =
  "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground";
const navActive = "bg-sidebar-accent text-sidebar-accent-foreground";

function CountPill({ feed }: { feed: Feed }) {
  const unread = useNotificationStore(feed, (s) => s.metadata.unread_count);
  if (!unread) return null;
  return (
    <span className="ml-auto rounded-full bg-blue-500 px-1.5 py-0.5 text-[11px] font-semibold leading-none text-white">
      {unread > 99 ? "99+" : unread}
    </span>
  );
}

// ─── Variant A: Knock's own bell and popover ───

function VariantAHeader() {
  const { knockConfig, userId } = useProto();
  const [mounted, setMounted] = useState(false);
  const [dark, setDark] = useState(false);
  useEffect(() => {
    setMounted(true);
    setDark(document.documentElement.classList.contains("dark"));
  }, []);
  if (!mounted || !userId || !knockConfig.publicKey) return null;
  return (
    <KnockProvider
      apiKey={knockConfig.publicKey}
      user={{ id: String(userId) }}
    >
      <KnockFeedProvider
        feedId={knockConfig.feedId ?? undefined}
        colorMode={dark ? "dark" : "light"}
      >
        <KnockBell />
      </KnockFeedProvider>
    </KnockProvider>
  );
}

function KnockBell() {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const navigate = useNavigate();
  return (
    <>
      <NotificationIconButton
        ref={buttonRef}
        badgeCountType="unread"
        onClick={() => setOpen((o) => !o)}
      />
      <NotificationFeedPopover
        buttonRef={buttonRef}
        isVisible={open}
        placement="bottom-start"
        onClose={() => setOpen(false)}
        onNotificationClick={(item) => {
          setOpen(false);
          const url = (item.data as { url?: string } | null)?.url;
          if (url) navigate(url);
        }}
      />
    </>
  );
}

// ─── Variant B: sidebar row opening a full-height panel beside the sidebar ───

function VariantBNav({ feed }: { feed: Feed }) {
  const [open, setOpen] = useState(false);
  const { items } = useNotificationStore(feed);
  const onOpen = useOpenItem(feed, () => setOpen(false));
  const unread = items.filter((i) => !i.read_at);
  return (
    <>
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(navRow, open ? navActive : navIdle)}
      >
        <Bell className="size-4" />
        Notifications
        <CountPill feed={feed} />
      </button>
      {open && (
        <>
          <div
            className="fixed inset-y-0 left-56 right-0 z-30 bg-black/20"
            onClick={() => setOpen(false)}
          />
          <div className="fixed inset-y-0 left-56 z-40 flex w-96 flex-col border-r bg-background text-foreground shadow-xl">
            <div className="flex h-14 items-center justify-between border-b px-4">
              <span className="font-semibold">Notifications</span>
              <div className="flex items-center gap-3">
                {unread.length > 0 && (
                  <button
                    className="text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => feed.markAllAsRead()}
                  >
                    Mark all as read
                  </button>
                )}
                <button onClick={() => setOpen(false)}>
                  <X className="size-4" />
                </button>
              </div>
            </div>
            <div className="flex-1 divide-y overflow-y-auto">
              {items.length === 0 ? (
                <Empty text="No notifications yet." />
              ) : (
                items.map((item) => (
                  <Row key={item.id} item={item} onOpen={onOpen} />
                ))
              )}
            </div>
          </div>
        </>
      )}
    </>
  );
}

// ─── Variant C: sidebar row leading to a full page ───

function VariantCNav({ feed }: { feed: Feed }) {
  return (
    <NavLink
      to="/notifications"
      className={({ isActive }) => cn(navRow, isActive ? navActive : navIdle)}
    >
      <Bell className="size-4" />
      Notifications
      <CountPill feed={feed} />
    </NavLink>
  );
}

export function PrototypeNotificationsPage() {
  const { feed, userId } = useProto();
  return (
    <div className="mx-auto max-w-3xl p-6 lg:p-8">
      <nav className="mb-6 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground">
          Home
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground">Notifications</span>
      </nav>
      {!userId ? (
        <Empty text="Select a user from the DevUI panel." />
      ) : !feed ? (
        <Empty text="Loading…" />
      ) : (
        <PageBody feed={feed} />
      )}
    </div>
  );
}

function PageBody({ feed }: { feed: Feed }) {
  const { items } = useNotificationStore(feed);
  const [tab, setTab] = useState<"unread" | "all">("unread");
  const onOpen = useOpenItem(feed);
  const unread = items.filter((i) => !i.read_at);
  const shown = tab === "unread" ? unread : items;
  return (
    <>
      <div className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-3xl font-bold">Notifications</h1>
          <p className="mt-1 text-muted-foreground">
            {unread.length === 0
              ? "You're up to date."
              : `${unread.length} unread.`}
          </p>
        </div>
        {unread.length > 0 && (
          <button
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
            onClick={() => feed.markAllAsRead()}
          >
            Mark all as read
          </button>
        )}
      </div>
      <div className="mb-4 flex gap-2">
        {(["unread", "all"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium capitalize",
              tab === t
                ? "bg-primary text-primary-foreground"
                : "border hover:bg-accent"
            )}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="divide-y overflow-hidden rounded-xl border bg-card">
        {shown.length === 0 ? (
          <Empty
            text={tab === "unread" ? "Nothing unread." : "No notifications yet."}
          />
        ) : (
          shown.map((item) => (
            <Row key={item.id} item={item} onOpen={onOpen} roomy />
          ))
        )}
      </div>
    </>
  );
}

// ─── Variant D: bell by the person's name, small popover, dot instead of a count ───

function VariantDUser({ feed }: { feed: Feed }) {
  const [open, setOpen] = useState(false);
  const { items, metadata } = useNotificationStore(feed);
  const onOpen = useOpenItem(feed, () => setOpen(false));
  const unread = items.filter((i) => !i.read_at);
  return (
    <>
      <button
        title="Notifications"
        onClick={() => setOpen((o) => !o)}
        className="relative rounded-md p-1 text-sidebar-foreground/50 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      >
        <Bell className="size-4" />
        {metadata.unread_count > 0 && (
          <span className="absolute right-0.5 top-0.5 size-2 rounded-full bg-blue-500 ring-2 ring-sidebar" />
        )}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="fixed bottom-4 left-[14.5rem] z-40 flex max-h-[60vh] w-80 flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-xl">
            <div className="flex items-center justify-between border-b px-4 py-2.5">
              <span className="text-sm font-semibold">Unread</span>
              {unread.length > 0 && (
                <button
                  className="text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => feed.markAllAsRead()}
                >
                  Mark all as read
                </button>
              )}
            </div>
            <div className="divide-y overflow-y-auto">
              {unread.length === 0 ? (
                <Empty />
              ) : (
                unread.map((item) => (
                  <Row key={item.id} item={item} onOpen={onOpen} />
                ))
              )}
            </div>
          </div>
        </>
      )}
    </>
  );
}

// ─── Slots the sidebar renders ───

export function PrototypeSidebarSlot({
  slot,
}: {
  slot: "header" | "nav" | "user";
}) {
  const { variant, feed } = useProto();
  if (slot === "header") return variant === "A" ? <VariantAHeader /> : null;
  if (!feed) return null;
  if (slot === "nav" && variant === "B") return <VariantBNav feed={feed} />;
  if (slot === "nav" && variant === "C") return <VariantCNav feed={feed} />;
  if (slot === "user" && variant === "D") return <VariantDUser feed={feed} />;
  return null;
}

// ─── Floating switcher (not part of any design) ───

function FeedState({ feed }: { feed: Feed }) {
  const { metadata, items } = useNotificationStore(feed);
  return (
    <span>
      {metadata.unread_count} unread · {items.length} loaded
    </span>
  );
}

export function PrototypeSwitcher() {
  const { variant, setVariant, feed, userId, knockConfig } = useProto();
  const fetcher = useFetcher<{ ok: boolean; status: number; error?: string }>();

  function cycle(step: number) {
    const i = KEYS.indexOf(variant);
    setVariant(KEYS[(i + step + KEYS.length) % KEYS.length]);
  }
  const cycleRef = useRef(cycle);
  cycleRef.current = cycle;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, select, [contenteditable]")) return;
      if (e.key === "ArrowLeft") cycleRef.current(-1);
      if (e.key === "ArrowRight") cycleRef.current(1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (process.env.NODE_ENV === "production") return null;

  return (
    <div className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-full bg-fuchsia-600 px-3 py-1.5 font-mono text-xs text-white shadow-2xl">
      <button onClick={() => cycle(-1)} title="Previous variant (←)">
        <ChevronLeft className="size-4" />
      </button>
      <span className="font-semibold">
        {variant} ({VARIANTS[variant]})
      </span>
      <button onClick={() => cycle(1)} title="Next variant (→)">
        <ChevronRight className="size-4" />
      </button>
      <span className="opacity-80">
        {!knockConfig.publicKey
          ? "no Knock key in .env"
          : !userId
            ? "no user selected"
            : feed
              ? <>user {userId} · <FeedState feed={feed} /></>
              : "connecting…"}
      </span>
      <fetcher.Form method="post" action="/api/prototype-notify">
        <button
          disabled={!userId || fetcher.state !== "idle"}
          className="rounded-full bg-white/20 px-2 py-0.5 hover:bg-white/30 disabled:opacity-50"
        >
          {fetcher.state !== "idle" ? "sending…" : "send me one"}
        </button>
      </fetcher.Form>
      {fetcher.data && !fetcher.data.ok && (
        <span className="max-w-64 truncate" title={fetcher.data.error}>
          failed {fetcher.data.status}
        </span>
      )}
    </div>
  );
}
