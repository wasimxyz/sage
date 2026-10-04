import { PlusIcon, Trash2Icon } from "lucide-react";
import {
  type ChangeEvent,
  createContext,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";

import type { SaveMemoryInput } from "@/bridge";
import { useMemories } from "@/components/memories-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { formatMemoryDate } from "@/lib/format-relative-age";
import { groupForSubjectKey } from "@/lib/group-facts";
import {
  appendDraft,
  draftsFromRecords,
  type FactDraft,
  type FactRecord,
  factEditsCanSave,
  insertDraftAfter,
  planFactEdits,
  removeDraft,
} from "@/lib/memory-fact-edits";
import { pageColumnClass } from "@/lib/page-column";
import { cn } from "@/lib/utils";

const emptyMeta = {};

interface FactDraftsState {
  busy: boolean;
  canSave: boolean;
  drafts: FactDraft[];
}

interface FactDraftsActions {
  addLast: () => void;
  bindInput: (key: string, node: HTMLInputElement | null) => void;
  cancel: () => void;
  change: (key: string, text: string) => void;
  keyDown: (
    event: KeyboardEvent<HTMLInputElement>,
    key: string,
    index: number
  ) => void;
  remove: (key: string) => void;
  submit: (event: FormEvent<HTMLFormElement>) => void;
}

interface FactDraftsContextValue {
  actions: FactDraftsActions;
  meta: Record<string, never>;
  state: FactDraftsState;
}

const FactDraftsContext = createContext<FactDraftsContextValue | null>(null);

function useFactDrafts(): FactDraftsContextValue {
  const value = use(FactDraftsContext);
  if (!value) {
    throw new Error("FactDraftsProvider is missing.");
  }
  return value;
}

export function ProfileSubjectRead() {
  const {
    actions: { openEdit },
    state: { profile },
  } = useMemories();
  const rows = useMemo(() => sortByRecency(profile), [profile]);
  const handleEdit = useCallback(() => {
    openEdit({ kind: "profile-group" });
  }, [openEdit]);
  const [newest] = rows;
  if (newest === undefined) {
    return null;
  }
  return (
    <SubjectReadView
      facts={rows.map((row) => ({ id: row.id, text: row.fact }))}
      onEdit={handleEdit}
      summary={newest.fact}
      updatedAt={newest.updatedAt}
    />
  );
}

export function TopicSubjectRead() {
  const {
    actions: { openEdit },
    state: { facts, subjectView },
  } = useMemories();
  const group =
    subjectView?.kind === "topic"
      ? groupForSubjectKey(facts, subjectView.key)
      : null;
  const handleEdit = useCallback(() => {
    if (subjectView?.kind !== "topic") {
      return;
    }
    openEdit({ key: subjectView.key, kind: "fact-group" });
  }, [openEdit, subjectView]);
  if (!group) {
    return null;
  }
  return (
    <SubjectReadView
      facts={group.facts.map((row) => ({ id: row.id, text: row.fact }))}
      onEdit={handleEdit}
      summary={group.snippet}
      updatedAt={group.updatedAt}
    />
  );
}

export function ProfileSubjectEditor() {
  const {
    actions: { closeEditor, saveAll },
    state: { profile },
  } = useMemories();
  const [snapshot] = useState(() => {
    const sorted = sortByRecency(profile);
    return {
      records: sorted.map((row) => ({ fact: row.fact, id: row.id })),
      summary: sorted[0]?.fact ?? "",
      updatedAt: sorted[0]?.updatedAt ?? "",
    };
  });
  const handleCommit = useCallback(
    async (drafts: FactDraft[]) => {
      const plan = planFactEdits(snapshot.records, drafts);
      await saveAll(
        plan.saves.map(
          (item): SaveMemoryInput => ({
            fact: item.fact,
            id: item.id,
            kind: "profile",
          })
        ),
        { ids: plan.deletes, kind: "profile" }
      );
    },
    [saveAll, snapshot.records]
  );
  if (snapshot.records.length === 0) {
    return null;
  }
  return (
    <FactDraftsSession
      initial={snapshot.records}
      onCancel={closeEditor}
      onCommit={handleCommit}
      summary={snapshot.summary}
      updatedAt={snapshot.updatedAt}
    />
  );
}

export function TopicSubjectEditor() {
  const {
    actions: { closeEditor, saveAll },
    state: { facts, subjectView },
  } = useMemories();
  const [snapshot] = useState(() => {
    const group =
      subjectView?.kind === "topic"
        ? groupForSubjectKey(facts, subjectView.key)
        : null;
    return {
      records:
        group?.facts.map((row) => ({
          fact: row.fact,
          id: row.id,
          subject: row.subject,
        })) ?? [],
      subject: group?.subject ?? "",
      summary: group?.snippet ?? "",
      updatedAt: group?.updatedAt ?? "",
    };
  });
  const handleCommit = useCallback(
    async (drafts: FactDraft[]) => {
      const plan = planFactEdits(snapshot.records, drafts, snapshot.subject);
      await saveAll(
        plan.saves.map(
          (item): SaveMemoryInput => ({
            fact: item.fact,
            id: item.id,
            kind: "fact",
            subject: item.subject ?? snapshot.subject,
          })
        ),
        { ids: plan.deletes, kind: "fact" }
      );
    },
    [saveAll, snapshot]
  );
  if (snapshot.records.length === 0) {
    return null;
  }
  return (
    <FactDraftsSession
      initial={snapshot.records}
      onCancel={closeEditor}
      onCommit={handleCommit}
      summary={snapshot.summary}
      updatedAt={snapshot.updatedAt}
    />
  );
}

function SubjectReadView({
  facts,
  onEdit,
  summary,
  updatedAt,
}: {
  facts: { id: number; text: string }[];
  onEdit: () => void;
  summary: string;
  updatedAt: string;
}) {
  return (
    <div className="flex flex-col gap-6">
      <SubjectOverview summary={summary} updatedAt={updatedAt} />
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-muted-foreground text-sm">Details</p>
          <Button onClick={onEdit} size="sm" type="button" variant="outline">
            Edit
          </Button>
        </div>
        <ul className="flex flex-col gap-1">
          {facts.map((fact) => (
            <li className="text-sm" key={fact.id}>
              <span className="mr-2 text-muted-foreground">•</span>
              {fact.text}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function SubjectOverview({
  summary,
  updatedAt,
}: {
  summary: string;
  updatedAt: string;
}) {
  const updated = formatMemoryDate(updatedAt);
  return (
    <>
      <div className="flex flex-col gap-1">
        <p className="text-muted-foreground text-sm">Last updated</p>
        <p className="text-sm">{updated.length > 0 ? updated : "Unknown"}</p>
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-muted-foreground text-sm">Summary</p>
        <p className="text-sm">{summary}</p>
      </div>
    </>
  );
}

function FactDraftsSession({
  initial,
  onCancel,
  onCommit,
  summary,
  updatedAt,
}: {
  initial: FactRecord[];
  onCancel: () => void;
  onCommit: (drafts: FactDraft[]) => Promise<void>;
  summary: string;
  updatedAt: string;
}) {
  return (
    <FactDraftsProvider
      initial={initial}
      onCancel={onCancel}
      onCommit={onCommit}
    >
      <FactDraftsForm summary={summary} updatedAt={updatedAt} />
    </FactDraftsProvider>
  );
}

function FactDraftsProvider({
  children,
  initial,
  onCancel,
  onCommit,
}: {
  children: ReactNode;
  initial: FactRecord[];
  onCancel: () => void;
  onCommit: (drafts: FactDraft[]) => Promise<void>;
}) {
  const originalRef = useRef(initial);
  const inputRefs = useRef(new Map<string, HTMLInputElement>());
  const pendingFocusKey = useRef<string | null>(null);
  const [drafts, setDrafts] = useState(() => draftsFromRecords(initial));
  const [busy, setBusy] = useState(false);
  const canSave = factEditsCanSave(originalRef.current, drafts) && !busy;

  useEffect(() => {
    if (drafts.length === 0) {
      return;
    }
    const pendingKey = pendingFocusKey.current;
    if (pendingKey === null) {
      return;
    }
    const pendingNode = inputRefs.current.get(pendingKey);
    if (pendingNode === undefined) {
      return;
    }
    pendingFocusKey.current = null;
    focusDraftInput(pendingNode);
  }, [drafts]);

  const bindInput = useCallback(
    (key: string, node: HTMLInputElement | null) => {
      if (node) {
        inputRefs.current.set(key, node);
        return;
      }
      inputRefs.current.delete(key);
    },
    []
  );

  const change = useCallback((key: string, text: string) => {
    setDrafts((current) =>
      current.map((draft) => (draft.key === key ? { ...draft, text } : draft))
    );
  }, []);

  const addAfter = useCallback((index: number) => {
    setDrafts((current) => {
      const next = insertDraftAfter(current, index);
      pendingFocusKey.current = next.key;
      return next.drafts;
    });
  }, []);

  const addLast = useCallback(() => {
    setDrafts((current) => {
      const next = appendDraft(current);
      pendingFocusKey.current = next.key;
      return next.drafts;
    });
  }, []);

  const remove = useCallback((key: string) => {
    setDrafts((current) => {
      const next = removeDraft(current, key);
      pendingFocusKey.current = next.focusKey;
      return next.drafts;
    });
  }, []);

  const keyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>, key: string, index: number) => {
      if (event.nativeEvent.isComposing) {
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        addAfter(index);
        return;
      }
      if (event.key === "Backspace" && event.currentTarget.value.length === 0) {
        event.preventDefault();
        remove(key);
      }
    },
    [addAfter, remove]
  );

  const submit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!canSave) {
        return;
      }
      setBusy(true);
      onCommit(drafts)
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
    [canSave, drafts, onCommit]
  );

  const state = useMemo<FactDraftsState>(
    () => ({ busy, canSave, drafts }),
    [busy, canSave, drafts]
  );
  const actions = useMemo<FactDraftsActions>(
    () => ({
      addLast,
      bindInput,
      cancel: onCancel,
      change,
      keyDown,
      remove,
      submit,
    }),
    [addLast, bindInput, change, keyDown, onCancel, remove, submit]
  );
  const value = useMemo<FactDraftsContextValue>(
    () => ({ actions, meta: emptyMeta, state }),
    [actions, state]
  );

  return <FactDraftsContext value={value}>{children}</FactDraftsContext>;
}

function FactDraftsForm({
  summary,
  updatedAt,
}: {
  summary: string;
  updatedAt: string;
}) {
  const {
    actions: { submit },
  } = useFactDrafts();
  return (
    <form className="flex min-h-0 flex-1 flex-col" onSubmit={submit}>
      <ScrollArea className="min-h-0 flex-1">
        <div className={cn(pageColumnClass, "pt-2 pb-4")}>
          <div className="flex flex-col gap-6">
            <SubjectOverview summary={summary} updatedAt={updatedAt} />
            <SubjectFactsFields />
          </div>
        </div>
      </ScrollArea>
      <SubjectFactsEditorBar />
    </form>
  );
}

function SubjectFactsFields() {
  const {
    actions: { addLast },
    state: { busy, drafts },
  } = useFactDrafts();
  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground text-sm">Details</p>
      <ul className="flex flex-col gap-1">
        {drafts.map((draft, index) => (
          <FactDraftRow draft={draft} index={index} key={draft.key} />
        ))}
      </ul>
      <div>
        <Button
          disabled={busy}
          onClick={addLast}
          size="sm"
          type="button"
          variant="ghost"
        >
          <PlusIcon data-icon="inline-start" />
          Add fact
        </Button>
      </div>
    </div>
  );
}

function FactDraftRow({ draft, index }: { draft: FactDraft; index: number }) {
  const {
    actions: { bindInput, change, keyDown, remove },
    state: { busy },
  } = useFactDrafts();
  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      change(draft.key, event.target.value);
    },
    [change, draft.key]
  );
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      keyDown(event, draft.key, index);
    },
    [draft.key, index, keyDown]
  );
  const handleRef = useCallback(
    (node: HTMLInputElement | null) => {
      bindInput(draft.key, node);
    },
    [bindInput, draft.key]
  );
  const handleRemove = useCallback(() => {
    remove(draft.key);
  }, [draft.key, remove]);
  const label = `Fact ${index + 1}`;
  return (
    <li className="flex items-center gap-2">
      <span className="text-muted-foreground">•</span>
      <Input
        aria-label={label}
        autoComplete="off"
        autoFocus={index === 0}
        className="min-w-0 flex-1"
        disabled={busy}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        ref={handleRef}
        value={draft.text}
      />
      <Button
        aria-label={`Delete ${label}`}
        disabled={busy}
        onClick={handleRemove}
        size="icon-sm"
        type="button"
        variant="ghost"
      >
        <Trash2Icon />
      </Button>
    </li>
  );
}

function SubjectFactsEditorBar() {
  const {
    actions: { cancel },
    state,
  } = useFactDrafts();
  return (
    <div className="shrink-0 border-border border-t">
      <div
        className={cn(
          pageColumnClass,
          "flex flex-wrap items-center justify-between gap-3 py-3"
        )}
      >
        <p className="min-w-0 text-muted-foreground text-xs">
          Press Enter to add a fact below. Press Backspace on an empty line to
          remove it.
        </p>
        <div className="flex shrink-0 items-center justify-end gap-2">
          <Button
            disabled={state.busy}
            onClick={cancel}
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
          <Button disabled={!state.canSave} type="submit">
            {state.busy ? <Spinner data-icon="inline-start" /> : null}
            Save changes
          </Button>
        </div>
      </div>
    </div>
  );
}

function focusDraftInput(node: HTMLInputElement) {
  node.focus();
  const offset = node.value.length;
  node.setSelectionRange(offset, offset);
}

function sortByRecency<T extends { id: number; updatedAt: string }>(
  rows: T[]
): T[] {
  return [...rows].sort((left, right) => {
    const byDate = right.updatedAt.localeCompare(left.updatedAt);
    if (byDate !== 0) {
      return byDate;
    }
    return right.id - left.id;
  });
}
