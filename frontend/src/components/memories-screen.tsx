import {
  BookmarkIcon,
  CalendarIcon,
  ChevronsRightIcon,
  PlusIcon,
  UserIcon,
} from "lucide-react";
import {
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
  useCallback,
  useMemo,
  useState,
} from "react";
import { toast } from "sonner";

import type { EventMemory, MemoryKind, ProfileMemory } from "@/bridge";
import { onTitlebarPointerDown } from "@/components/app-titlebar";
import {
  type MemoryDeleteTarget,
  type MemoryEditor,
  useMemories,
} from "@/components/memories-provider";
import {
  ProfileSubjectEditor,
  ProfileSubjectRead,
  TopicSubjectEditor,
  TopicSubjectRead,
} from "@/components/memory-subject-editor";
import { PanelIconButton } from "@/components/panel-icon-button";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Dialog,
  DialogActions,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  calendarDateKey,
  formatEntryDate,
  parseCalendarDate,
} from "@/lib/format-date";
import { formatMemoryUpdatedOn } from "@/lib/format-relative-age";
import { type EventGroup, groupEvents } from "@/lib/group-events";
import {
  type FactSubjectGroup,
  groupFactsBySubject,
  groupForSubjectKey,
} from "@/lib/group-facts";
import { pageColumnClass } from "@/lib/page-column";
import { isMemoriesTab } from "@/lib/route";
import { eventDateKey } from "@/lib/sort-events";
import { cn } from "@/lib/utils";

const datePrefixPattern = /^\d{4}-\d{2}-\d{2}/;
const skeletonRows = [0, 1, 2, 3, 4];

export function MemoriesScreen() {
  return (
    <>
      <MemoriesWorkspace />
      <MemoriesEditor />
      <MemoriesDeleteDialog />
    </>
  );
}

function MemoriesWorkspace() {
  const {
    state: { subjectView },
  } = useMemories();
  if (subjectView === null) {
    return <MemoriesListColumn />;
  }
  return <MemoriesSplitWorkspace />;
}

function MemoriesSplitWorkspace() {
  const isMobile = useIsMobile();
  return (
    <ResizablePanelGroup
      className="min-h-0 flex-1"
      orientation={isMobile ? "vertical" : "horizontal"}
    >
      <ResizablePanel defaultSize="40%" id="memories-list" minSize="20%">
        <MemoriesListColumn />
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel defaultSize="60%" id="memories-detail" minSize="20%">
        <MemoriesSubjectPane />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

function MemoriesListColumn() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <MemoriesHeader />
      <ScrollArea className="min-h-0 flex-1">
        <div className={cn(pageColumnClass, "pt-2 pb-4")}>
          <MemoriesTabs />
        </div>
      </ScrollArea>
    </div>
  );
}

function MemoriesSubjectPane() {
  const {
    state: { editor, subjectView },
  } = useMemories();
  if (subjectView?.kind === "profile") {
    return (
      <SubjectPaneFrame>
        {editor?.kind === "profile-group" ? (
          <ProfileSubjectEditor />
        ) : (
          <SubjectPaneBody>
            <ProfileSubjectRead />
          </SubjectPaneBody>
        )}
      </SubjectPaneFrame>
    );
  }
  if (subjectView?.kind === "topic") {
    return (
      <SubjectPaneFrame>
        {editor?.kind === "fact-group" ? (
          <TopicSubjectEditor />
        ) : (
          <SubjectPaneBody>
            <TopicSubjectRead />
          </SubjectPaneBody>
        )}
      </SubjectPaneFrame>
    );
  }
  return null;
}

function SubjectPaneFrame({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <SubjectHeader />
      {children}
    </div>
  );
}

function SubjectPaneBody({ children }: { children: ReactNode }) {
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className={cn(pageColumnClass, "pt-2 pb-4")}>{children}</div>
    </ScrollArea>
  );
}

function MemoriesHeader() {
  const {
    state: { tab },
  } = useMemories();
  if (tab === "events") {
    return <EventsMemoriesHeader />;
  }
  return <FactsMemoriesHeader />;
}

function MemoriesHeaderFrame({ children }: { children?: ReactNode }) {
  return (
    <div
      className="shrink-0 pt-(--titlebar-height) pb-1"
      data-slot="window-drag"
      onPointerDown={onTitlebarPointerDown}
    >
      <div
        className={cn(
          pageColumnClass,
          "flex h-8 items-center justify-between gap-2"
        )}
      >
        <h1 className="ml-3 min-w-0 truncate font-medium text-base">
          Memories
        </h1>
        {children}
      </div>
    </div>
  );
}

function FactsMemoriesHeader() {
  const {
    actions: { openCreate },
  } = useMemories();
  const handleAdd = useCallback(() => {
    openCreate("fact");
  }, [openCreate]);
  return (
    <MemoriesHeaderFrame>
      <Button onClick={handleAdd} size="sm" type="button">
        <PlusIcon data-icon="inline-start" />
        Add
      </Button>
    </MemoriesHeaderFrame>
  );
}

function EventsMemoriesHeader() {
  const {
    actions: { openCreate },
  } = useMemories();
  const handleAdd = useCallback(() => {
    openCreate("event");
  }, [openCreate]);
  return (
    <MemoriesHeaderFrame>
      <Button onClick={handleAdd} size="sm" type="button">
        <PlusIcon data-icon="inline-start" />
        Add
      </Button>
    </MemoriesHeaderFrame>
  );
}

function SubjectHeader() {
  const {
    state: { subjectView },
  } = useMemories();
  if (subjectView?.kind === "profile") {
    return <ProfileSubjectHeader />;
  }
  if (subjectView?.kind === "topic") {
    return <TopicSubjectHeader />;
  }
  return null;
}

function SubjectCloseBar() {
  const {
    actions: { closeSubject },
  } = useMemories();
  return (
    <div
      className="flex h-(--titlebar-height) shrink-0 items-center gap-2 px-6"
      data-slot="window-drag"
      onPointerDown={onTitlebarPointerDown}
    >
      <PanelIconButton aria-label="Close" onClick={closeSubject} type="button">
        <ChevronsRightIcon className="size-4.5" />
      </PanelIconButton>
    </div>
  );
}

function SubjectHeaderFrame({
  children,
  title,
}: {
  children?: ReactNode;
  title: string;
}) {
  return (
    <div className="shrink-0">
      <SubjectCloseBar />
      <div
        className={cn(
          pageColumnClass,
          "flex h-8 items-center justify-between gap-2 pb-1"
        )}
      >
        <h1 className="min-w-0 truncate font-medium text-base">{title}</h1>
        {children}
      </div>
    </div>
  );
}

function ProfileSubjectHeader() {
  const {
    actions: { openDelete },
    state: { profile },
  } = useMemories();
  const rows = useMemo(() => sortProfile(profile), [profile]);
  const handleDeleteGroup = useCallback(() => {
    openDelete({
      ids: rows.map((row) => row.id),
      kind: "profile-group",
      title: "You",
    });
  }, [openDelete, rows]);
  if (rows.length === 0) {
    return null;
  }
  return (
    <SubjectHeaderFrame title="You">
      <Button
        onClick={handleDeleteGroup}
        size="sm"
        type="button"
        variant="outline"
      >
        Delete
      </Button>
    </SubjectHeaderFrame>
  );
}

function TopicSubjectHeader() {
  const {
    actions: { openDelete },
    state: { facts, subjectView },
  } = useMemories();
  const group =
    subjectView?.kind === "topic"
      ? groupForSubjectKey(facts, subjectView.key)
      : null;
  const handleDeleteGroup = useCallback(() => {
    if (!group) {
      return;
    }
    openDelete({
      ids: group.facts.map((row) => row.id),
      kind: "fact-group",
      title: group.subject,
    });
  }, [group, openDelete]);
  if (!group) {
    return null;
  }
  return (
    <SubjectHeaderFrame title={group.subject}>
      <Button
        onClick={handleDeleteGroup}
        size="sm"
        type="button"
        variant="outline"
      >
        Delete
      </Button>
    </SubjectHeaderFrame>
  );
}

function MemoriesTabs() {
  const {
    actions: { setTab },
    state: { tab },
  } = useMemories();
  const handleTabChange = useCallback(
    (value: unknown) => {
      if (isMemoriesTab(value)) {
        setTab(value);
      }
    },
    [setTab]
  );
  return (
    <Tabs onValueChange={handleTabChange} value={tab}>
      <TabsList variant="line">
        <TabsTrigger value="facts">Facts</TabsTrigger>
        <TabsTrigger value="events">Events</TabsTrigger>
      </TabsList>
      <TabsContent className="pt-4" value="facts">
        <FactsPanel />
      </TabsContent>
      <TabsContent className="pt-4" value="events">
        <EventsPanel />
      </TabsContent>
    </Tabs>
  );
}

function FactsPanel() {
  return (
    <div className="flex flex-col gap-8">
      <ProfileSection />
      <TopicsSection />
    </div>
  );
}

function MemorySection({ children }: { children: ReactNode }) {
  return <section className="flex flex-col gap-2">{children}</section>;
}

function MemorySectionHeading({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 px-3">
      {children}
    </div>
  );
}

function ProfileSection() {
  return (
    <MemorySection>
      <MemorySectionHeading>
        <h2 className="font-medium text-sm">Profile</h2>
      </MemorySectionHeading>
      <ProfileList />
    </MemorySection>
  );
}

function TopicsSection() {
  return (
    <MemorySection>
      <MemorySectionHeading>
        <h2 className="font-medium text-sm">Topics</h2>
      </MemorySectionHeading>
      <TopicsList />
    </MemorySection>
  );
}

function ProfileList() {
  const {
    actions: { openProfileSubject },
    state: { loading, profile, subjectView },
  } = useMemories();
  const newest = useMemo(() => newestProfile(profile), [profile]);
  if (loading && profile.length === 0) {
    return <FactListSkeleton />;
  }
  if (newest === null) {
    return <ProfileEmpty />;
  }
  return (
    <ul aria-label="Profile" className="flex flex-col gap-0.5">
      <SubjectRow
        onOpen={openProfileSubject}
        selected={subjectView?.kind === "profile"}
        snippet={newest.fact}
        subject="You"
        updatedAt={newest.updatedAt}
      />
    </ul>
  );
}

function TopicsList() {
  const {
    actions: { openCreate, openFactSubject },
    state: { facts, loading, subjectView },
  } = useMemories();
  const groups = useMemo(() => groupFactsBySubject(facts), [facts]);
  const handleAdd = useCallback(() => {
    openCreate("fact");
  }, [openCreate]);
  if (loading && facts.length === 0) {
    return <FactListSkeleton />;
  }
  if (facts.length === 0) {
    return <TopicsEmpty onAdd={handleAdd} />;
  }
  const selectedKey = subjectView?.kind === "topic" ? subjectView.key : null;
  return (
    <ul aria-label="Topics" className="flex flex-col gap-0.5">
      {groups.map((group) => (
        <FactSubjectRow
          group={group}
          key={group.key}
          onOpen={openFactSubject}
          selected={group.key === selectedKey}
        />
      ))}
    </ul>
  );
}

function EventsPanel() {
  const {
    actions: { openCreate },
    state: { events, loading },
  } = useMemories();
  const grouped = useMemo(() => groupEvents(events), [events]);
  const handleAdd = useCallback(() => {
    openCreate("event");
  }, [openCreate]);
  if (loading && events.length === 0) {
    return <MemoryListSkeleton label="Loading events" />;
  }
  if (events.length === 0) {
    return (
      <MemoryEmpty
        description="Add an event, or run Sage > Dream."
        icon={<CalendarIcon />}
        onAdd={handleAdd}
        title="No events"
      />
    );
  }
  return (
    <div className="flex flex-col gap-8">
      {grouped.groups.map((group) => (
        <EventGroupSection group={group} key={group.key} />
      ))}
      {grouped.undated.length > 0 ? (
        <UndatedEventsSection events={grouped.undated} />
      ) : null}
    </div>
  );
}

function EventGroupSection({ group }: { group: EventGroup }) {
  return (
    <MemorySection>
      <MemorySectionHeading>
        <h2 className="font-medium text-sm">{group.title}</h2>
      </MemorySectionHeading>
      <EventList events={group.events} label={group.title} />
    </MemorySection>
  );
}

function UndatedEventsSection({ events }: { events: EventMemory[] }) {
  return (
    <MemorySection>
      <MemorySectionHeading>
        <h2 className="font-medium text-sm">No date</h2>
      </MemorySectionHeading>
      <EventList events={events} label="No date" />
    </MemorySection>
  );
}

function EventList({
  events,
  label,
}: {
  events: EventMemory[];
  label: string;
}) {
  const {
    actions: { openEdit },
  } = useMemories();
  return (
    <ul aria-label={label} className="flex flex-col gap-0.5">
      {events.map((row) => (
        <EventRow key={row.id} onEdit={openEdit} row={row} />
      ))}
    </ul>
  );
}

function FactSubjectRow({
  group,
  onOpen,
  selected,
}: {
  group: FactSubjectGroup;
  onOpen: (key: string) => void;
  selected: boolean;
}) {
  const handleOpen = useCallback(() => {
    onOpen(group.key);
  }, [group.key, onOpen]);
  return (
    <SubjectRow
      onOpen={handleOpen}
      selected={selected}
      snippet={group.snippet}
      subject={group.subject}
      updatedAt={group.updatedAt}
    />
  );
}

function SubjectRow({
  onOpen,
  selected,
  snippet,
  subject,
  updatedAt,
}: {
  onOpen: () => void;
  selected: boolean;
  snippet: string;
  subject: string;
  updatedAt: string;
}) {
  const updated = formatMemoryUpdatedOn(updatedAt);
  return (
    <li>
      <button
        aria-current={selected ? "true" : undefined}
        className={cn(
          "flex w-full cursor-pointer items-center gap-4 rounded-xl px-3 py-2.5 text-left hover:bg-foreground/5",
          selected && "bg-foreground/10 hover:bg-foreground/10"
        )}
        onClick={onOpen}
        type="button"
      >
        <span className="w-36 shrink-0 truncate font-medium text-sm">
          {subject}
        </span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground text-sm">
          {snippet}
        </span>
        {updated.length > 0 ? (
          <span className="shrink-0 text-muted-foreground text-sm">
            {updated}
          </span>
        ) : null}
      </button>
    </li>
  );
}

function EventRow({
  onEdit,
  row,
}: {
  onEdit: (editor: MemoryEditor) => void;
  row: EventMemory;
}) {
  const handleEdit = useCallback(() => {
    onEdit({
      event: row.event,
      id: row.id,
      kind: "event",
      occurredAt: row.occurredAt,
    });
  }, [onEdit, row.event, row.id, row.occurredAt]);
  const sourceTitle = row.sourceTitle.trim();
  return (
    <li>
      <button
        className="flex w-full cursor-pointer flex-col rounded-xl px-3 py-2.5 text-left hover:bg-foreground/5"
        onClick={handleEdit}
        type="button"
      >
        <span className="flex items-baseline justify-between gap-4">
          <span className="min-w-0 truncate font-medium text-sm">
            {row.event}
          </span>
          <span className="shrink-0 text-muted-foreground text-sm">
            {formatEventOccurred(row.occurredAt)}
          </span>
        </span>
        {sourceTitle.length > 0 ? (
          <EventSourceLine title={sourceTitle} />
        ) : null}
      </button>
    </li>
  );
}

function EventSourceLine({ title }: { title: string }) {
  return (
    <span className="truncate text-muted-foreground text-sm">From {title}</span>
  );
}

function ProfileEmpty() {
  return (
    <Empty className="min-h-40">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <UserIcon />
        </EmptyMedia>
        <EmptyTitle>No profile memories</EmptyTitle>
        <EmptyDescription>
          Add a profile sentence, or run Sage {">"} Dream.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function TopicsEmpty({ onAdd }: { onAdd: () => void }) {
  return (
    <Empty className="min-h-40">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <BookmarkIcon />
        </EmptyMedia>
        <EmptyTitle>No topics</EmptyTitle>
        <EmptyDescription>
          Add a fact, or run Sage {">"} Dream.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button onClick={onAdd} type="button">
          <PlusIcon data-icon="inline-start" />
          Add
        </Button>
      </EmptyContent>
    </Empty>
  );
}

function MemoryEmpty({
  description,
  icon,
  onAdd,
  title,
}: {
  description: string;
  icon: ReactNode;
  onAdd: () => void;
  title: string;
}) {
  return (
    <Empty className="min-h-64">
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon}</EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button onClick={onAdd} type="button">
          <PlusIcon data-icon="inline-start" />
          Add
        </Button>
      </EmptyContent>
    </Empty>
  );
}

function MemoryListSkeleton({ label }: { label: string }) {
  return (
    <div role="status">
      <span className="sr-only">{label}</span>
      {skeletonRows.map((row) => (
        <div
          className="flex items-start justify-between gap-4 rounded-xl px-3 py-2.5"
          key={row}
        >
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-64" />
            <Skeleton className="h-3 w-24" />
          </div>
          <Skeleton className="h-4 w-24 shrink-0" />
        </div>
      ))}
    </div>
  );
}

function FactListSkeleton() {
  return (
    <div role="status">
      <span className="sr-only">Loading facts</span>
      {skeletonRows.map((row) => (
        <div
          className="flex items-center gap-4 rounded-xl px-3 py-2.5"
          key={row}
        >
          <Skeleton className="h-4 w-36 shrink-0" />
          <Skeleton className="h-4 min-w-0 flex-1" />
          <Skeleton className="h-4 w-24 shrink-0" />
        </div>
      ))}
    </div>
  );
}

function MemoriesEditor() {
  const {
    state: { editor },
  } = useMemories();
  if (!editor) {
    return null;
  }
  if (editor.kind === "profile") {
    return <ProfileEditor editor={editor} />;
  }
  if (editor.kind === "fact") {
    return <FactEditor editor={editor} />;
  }
  if (editor.kind === "event") {
    return <EventEditor editor={editor} />;
  }
  return null;
}

function ProfileEditor({
  editor,
}: {
  editor: Extract<MemoryEditor, { kind: "profile" }>;
}) {
  const {
    actions: { closeEditor, save },
  } = useMemories();
  const [fact, setFact] = useState(editor.fact);
  const [busy, setBusy] = useState(false);
  const trimmed = fact.trim();
  const canSave = trimmed.length > 0 && !busy;
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (busy && !open) {
        return;
      }
      if (!open) {
        closeEditor();
      }
    },
    [busy, closeEditor]
  );
  const handleFactChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      setFact(event.target.value);
    },
    []
  );
  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!canSave) {
        return;
      }
      setBusy(true);
      save({ fact: trimmed, id: editor.id, kind: "profile" })
        .catch((caught: unknown) => {
          toast.error(
            caught instanceof Error
              ? caught.message
              : "Could not save this memory."
          );
        })
        .finally(() => {
          setBusy(false);
        });
    },
    [canSave, editor.id, save, trimmed]
  );
  return (
    <Dialog onOpenChange={handleOpenChange} open>
      <DialogContent className="sm:max-w-md">
        <form className="contents" onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>
              {editor.id === undefined ? "Add profile" : "Edit profile"}
            </DialogTitle>
            <DialogDescription>
              A lasting sentence about you. Chat may use it in later talks.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-disabled={busy ? true : undefined}>
              <FieldLabel htmlFor="memory-profile-fact">Fact</FieldLabel>
              <Textarea
                disabled={busy}
                id="memory-profile-fact"
                onChange={handleFactChange}
                value={fact}
              />
            </Field>
          </FieldGroup>
          <EditorActions busy={busy} canSave={canSave} />
        </form>
      </DialogContent>
    </Dialog>
  );
}

function FactEditor({
  editor,
}: {
  editor: Extract<MemoryEditor, { kind: "fact" }>;
}) {
  const {
    actions: { closeEditor, save },
  } = useMemories();
  const [subject, setSubject] = useState(editor.subject);
  const [fact, setFact] = useState(editor.fact);
  const [busy, setBusy] = useState(false);
  const trimmedSubject = subject.trim();
  const trimmedFact = fact.trim();
  const canSave = trimmedSubject.length > 0 && trimmedFact.length > 0 && !busy;
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (busy && !open) {
        return;
      }
      if (!open) {
        closeEditor();
      }
    },
    [busy, closeEditor]
  );
  const handleSubjectChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setSubject(event.target.value);
    },
    []
  );
  const handleFactChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      setFact(event.target.value);
    },
    []
  );
  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!canSave) {
        return;
      }
      setBusy(true);
      save({
        fact: trimmedFact,
        id: editor.id,
        kind: "fact",
        subject: trimmedSubject,
      })
        .catch((caught: unknown) => {
          toast.error(
            caught instanceof Error
              ? caught.message
              : "Could not save this memory."
          );
        })
        .finally(() => {
          setBusy(false);
        });
    },
    [canSave, editor.id, save, trimmedFact, trimmedSubject]
  );
  return (
    <Dialog onOpenChange={handleOpenChange} open>
      <DialogContent className="sm:max-w-md">
        <form className="contents" onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>
              {editor.id === undefined ? "Add fact" : "Edit fact"}
            </DialogTitle>
            <DialogDescription>
              A named fact Chat can search. Sage embeds it with Ollama.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-disabled={busy ? true : undefined}>
              <FieldLabel htmlFor="memory-fact-subject">Subject</FieldLabel>
              <Input
                autoComplete="off"
                disabled={busy}
                id="memory-fact-subject"
                onChange={handleSubjectChange}
                value={subject}
              />
            </Field>
            <Field data-disabled={busy ? true : undefined}>
              <FieldLabel htmlFor="memory-fact-fact">Fact</FieldLabel>
              <Textarea
                disabled={busy}
                id="memory-fact-fact"
                onChange={handleFactChange}
                value={fact}
              />
            </Field>
          </FieldGroup>
          <EditorActions busy={busy} canSave={canSave} />
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EventEditor({
  editor,
}: {
  editor: Extract<MemoryEditor, { kind: "event" }>;
}) {
  const {
    actions: { closeEditor, openDelete, save },
  } = useMemories();
  const [eventText, setEventText] = useState(editor.event);
  const [occurredAt, setOccurredAt] = useState(
    dateInputValue(editor.occurredAt)
  );
  const [busy, setBusy] = useState(false);
  const [dateOpen, setDateOpen] = useState(false);
  const trimmedEvent = eventText.trim();
  const canSave = trimmedEvent.length > 0 && !busy;
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (busy && !open) {
        return;
      }
      if (!open) {
        closeEditor();
      }
    },
    [busy, closeEditor]
  );
  const handleEventChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      setEventText(event.target.value);
    },
    []
  );
  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!canSave) {
        return;
      }
      setBusy(true);
      save({
        event: trimmedEvent,
        id: editor.id,
        kind: "event",
        occurredAt: occurredAt.trim(),
      })
        .catch((caught: unknown) => {
          toast.error(
            caught instanceof Error
              ? caught.message
              : "Could not save this memory."
          );
        })
        .finally(() => {
          setBusy(false);
        });
    },
    [canSave, editor.id, occurredAt, save, trimmedEvent]
  );
  const handleDelete = useCallback(() => {
    if (editor.id === undefined) {
      return;
    }
    openDelete({ id: editor.id, kind: "event", title: editor.event });
    closeEditor();
  }, [closeEditor, editor.event, editor.id, openDelete]);
  return (
    <Dialog
      disablePointerDismissal={dateOpen}
      modal="trap-focus"
      onOpenChange={handleOpenChange}
      open
    >
      <DialogContent className="sm:max-w-md">
        <form className="contents" onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>
              {editor.id === undefined ? "Add event" : "Edit event"}
            </DialogTitle>
            <DialogDescription>
              A dated event Chat can search. Sage embeds it with Ollama.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <EventDateField
              busy={busy}
              onChange={setOccurredAt}
              onOpenChange={setDateOpen}
              open={dateOpen}
              value={occurredAt}
            />
            <Field data-disabled={busy ? true : undefined}>
              <FieldLabel htmlFor="memory-event-event">Event</FieldLabel>
              <Textarea
                disabled={busy}
                id="memory-event-event"
                onChange={handleEventChange}
                value={eventText}
              />
            </Field>
          </FieldGroup>
          {editor.id === undefined ? (
            <EditorActions busy={busy} canSave={canSave} />
          ) : (
            <EventEditActions
              busy={busy}
              canSave={canSave}
              onDelete={handleDelete}
            />
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EventDateField({
  busy,
  onChange,
  onOpenChange,
  open,
  value,
}: {
  busy: boolean;
  onChange: (value: string) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  value: string;
}) {
  const selected = useMemo(
    () => parseCalendarDate(value) ?? undefined,
    [value]
  );
  const handleSelect = useCallback(
    (date: Date | undefined) => {
      onChange(date ? calendarDateKey(date) : "");
      onOpenChange(false);
    },
    [onChange, onOpenChange]
  );
  return (
    <Field data-disabled={busy ? true : undefined}>
      <FieldLabel htmlFor="memory-event-occurred-at">Date</FieldLabel>
      <Popover onOpenChange={onOpenChange} open={open}>
        <PopoverTrigger
          disabled={busy}
          render={
            <Button
              className={cn(
                "w-full justify-start border-input bg-transparent hover:bg-transparent aria-expanded:bg-transparent",
                !selected && "text-muted-foreground"
              )}
              disabled={busy}
              id="memory-event-occurred-at"
              type="button"
              variant="outline"
            />
          }
        >
          <CalendarIcon data-icon="inline-start" />
          {selected ? formatEntryDate(value) : "Pick a date"}
        </PopoverTrigger>
        <PopoverContent align="start" className="w-auto p-0">
          <Calendar
            defaultMonth={selected}
            mode="single"
            onSelect={handleSelect}
            selected={selected}
          />
        </PopoverContent>
      </Popover>
    </Field>
  );
}

function EditorActions({ busy, canSave }: { busy: boolean; canSave: boolean }) {
  return (
    <DialogActions>
      <EditorActionPair busy={busy} canSave={canSave} />
    </DialogActions>
  );
}

function EventEditActions({
  busy,
  canSave,
  onDelete,
}: {
  busy: boolean;
  canSave: boolean;
  onDelete: () => void;
}) {
  return (
    <DialogActions className="sm:justify-between">
      <Button
        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
        disabled={busy}
        onClick={onDelete}
        type="button"
        variant="ghost"
      >
        Delete
      </Button>
      <div className="flex flex-col-reverse gap-2 sm:flex-row">
        <EditorActionPair busy={busy} canSave={canSave} />
      </div>
    </DialogActions>
  );
}

function EditorActionPair({
  busy,
  canSave,
}: {
  busy: boolean;
  canSave: boolean;
}) {
  return (
    <>
      <DialogClose disabled={busy} render={<Button variant="outline" />}>
        Cancel
      </DialogClose>
      <Button disabled={!canSave} type="submit">
        {busy ? <Spinner data-icon="inline-start" /> : null}
        Save
      </Button>
    </>
  );
}

function MemoriesDeleteDialog() {
  const {
    actions: { closeDelete, remove, removeMany },
    state: { deleteTarget },
  } = useMemories();
  const [busy, setBusy] = useState(false);
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (busy && !open) {
        return;
      }
      if (!open) {
        closeDelete();
      }
    },
    [busy, closeDelete]
  );
  const handleConfirm = useCallback(() => {
    if (!deleteTarget || busy) {
      return;
    }
    setBusy(true);
    confirmDelete(deleteTarget, remove, removeMany)
      .catch(() => undefined)
      .finally(() => {
        setBusy(false);
      });
  }, [busy, deleteTarget, remove, removeMany]);
  if (!deleteTarget) {
    return null;
  }
  const copy = deleteCopy(deleteTarget);
  return (
    <Dialog onOpenChange={handleOpenChange} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        <DialogActions>
          <DialogClose disabled={busy} render={<Button variant="outline" />}>
            Cancel
          </DialogClose>
          <Button disabled={busy} onClick={handleConfirm} variant="destructive">
            {busy ? <Spinner data-icon="inline-start" /> : null}
            Delete
          </Button>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}

function confirmDelete(
  target: MemoryDeleteTarget,
  remove: (kind: MemoryKind, id: number) => Promise<void>,
  removeMany: (kind: "fact" | "profile", ids: number[]) => Promise<void>
): Promise<void> {
  if (target.kind === "fact-group") {
    return removeMany("fact", target.ids);
  }
  if (target.kind === "profile-group") {
    return removeMany("profile", target.ids);
  }
  return remove(target.kind, target.id);
}

function deleteCopy(target: MemoryDeleteTarget): {
  description: string;
  title: string;
} {
  if (target.kind === "profile") {
    return {
      description: `This removes "${target.title}" from Memories on this machine. You cannot undo it.`,
      title: "Delete this profile memory?",
    };
  }
  if (target.kind === "fact") {
    return {
      description: `This removes "${target.title}" from Memories on this machine. You cannot undo it.`,
      title: "Delete this fact?",
    };
  }
  if (target.kind === "profile-group") {
    if (target.ids.length === 1) {
      return {
        description: `This removes "${target.title}" from Memories on this machine. You cannot undo it.`,
        title: "Delete this profile memory?",
      };
    }
    return {
      description: `This removes every profile sentence under "${target.title}" from Memories on this machine. You cannot undo it.`,
      title: "Delete these profile memories?",
    };
  }
  if (target.kind === "fact-group") {
    if (target.ids.length === 1) {
      return {
        description: `This removes "${target.title}" from Memories on this machine. You cannot undo it.`,
        title: "Delete this fact?",
      };
    }
    return {
      description: `This removes every fact under "${target.title}" from Memories on this machine. You cannot undo it.`,
      title: "Delete these facts?",
    };
  }
  return {
    description: `This removes "${target.title}" from Memories on this machine. You cannot undo it.`,
    title: "Delete this event?",
  };
}

function newestProfile(rows: ProfileMemory[]): ProfileMemory | null {
  const [newest] = sortProfile(rows);
  return newest ?? null;
}

function sortProfile(rows: ProfileMemory[]): ProfileMemory[] {
  return [...rows].sort((left, right) => {
    const byDate = right.updatedAt.localeCompare(left.updatedAt);
    if (byDate !== 0) {
      return byDate;
    }
    return right.id - left.id;
  });
}

function formatEventOccurred(value: string): string {
  const dated = eventDateKey(value);
  if (dated.length === 0) {
    return "No date";
  }
  return formatEntryDate(dated.slice(0, 10));
}

function dateInputValue(value: string): string {
  const trimmed = value.trim();
  if (datePrefixPattern.test(trimmed)) {
    return trimmed.slice(0, 10);
  }
  return "";
}
