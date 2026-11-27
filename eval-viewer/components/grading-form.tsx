"use client";

import {
  type ChangeEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { saveGrade } from "@/app/calibration/actions";
import { CalibrationContext } from "@/components/calibration-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  type CalibrationItem,
  type CalibrationSample,
  type CheckGrade,
  emptyDraft,
  type GradeDraft,
  type ItemState,
  itemState,
  maxNoteLength,
  type RubricGrade,
  rubricLevels,
  sampleProgress,
} from "@/lib/reports/calibration.ts";
import {
  checkHint,
  checkLabel,
  checkTier,
  tierLabel,
} from "@/lib/reports/check-info.ts";

type Drafts = Record<string, GradeDraft | undefined>;

type SaveStatus =
  | { kind: "error"; reason: string }
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "saved"; at: string }
  | { kind: "saving" };

interface Option {
  label: string;
  value: string;
}

const saveDelayMs = 600;

const checkOptions: Option[] = [
  { label: "Pass", value: "pass" },
  { label: "Fail", value: "fail" },
  { label: "N/A", value: "na" },
];

const rubricOptions: Option[] = [
  ...rubricLevels.map((level) => ({
    label: String(level),
    value: String(level),
  })),
  { label: "N/A", value: "na" },
];

/** The answer a toggle shows: nothing, or the one value you picked. */
function checkValue(grade: CheckGrade | undefined): string[] {
  if (grade === undefined) {
    return [];
  }
  if (grade === null) {
    return ["na"];
  }
  return [grade ? "pass" : "fail"];
}

/** Null is N/A and undefined is no answer, as when you click a pressed toggle off. */
function checkFromValue(value: string | undefined): CheckGrade | undefined {
  if (value === "pass") {
    return true;
  }
  if (value === "fail") {
    return false;
  }
  return value === "na" ? null : undefined;
}

function rubricValue(grade: RubricGrade | undefined): string[] {
  if (grade === undefined) {
    return [];
  }
  return [grade === null ? "na" : String(grade)];
}

function rubricFromValue(value: string | undefined): RubricGrade | undefined {
  if (value === "na") {
    return null;
  }
  return rubricLevels.find((candidate) => String(candidate) === value);
}

/** A copy of the record without the key, so a toggle you click off goes back to unanswered. */
function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).filter(([name]) => name !== key)
  );
}

/** The first item with something left to grade, or the first item. */
function firstOpenIndex(sample: CalibrationSample, drafts: Drafts): number {
  const index = sample.items.findIndex(
    (item) => itemState(item, drafts[item.id]) !== "done"
  );
  return index === -1 ? 0 : index;
}

const stateMark: Record<ItemState, string> = {
  done: "●",
  empty: "○",
  started: "◐",
};

const stateName: Record<ItemState, string> = {
  done: "graded",
  empty: "not started",
  started: "started",
};

export function GradingForm({
  initial,
  sample,
  sampleFile,
}: {
  initial: Drafts;
  sample: CalibrationSample;
  sampleFile: string;
}) {
  const [drafts, setDrafts] = useState<Drafts>(initial);
  const draftsRef = useRef<Drafts>(initial);
  const [index, setIndex] = useState(() => firstOpenIndex(sample, initial));
  const [status, setStatus] = useState<SaveStatus>({ kind: "idle" });
  const timers = useRef(new Map<string, number>());
  const queue = useRef<Promise<void>>(Promise.resolve());

  // Saves go one after another, each with the newest draft of its item.
  const persist = useCallback(
    (id: string) => {
      queue.current = queue.current.then(async () => {
        const draft = draftsRef.current[id];
        if (draft === undefined) {
          return;
        }
        setStatus({ kind: "saving" });
        try {
          const result = await saveGrade(sampleFile, { id, ...draft });
          setStatus(
            result.ok
              ? { at: result.gradedAt, kind: "saved" }
              : { kind: "error", reason: result.reason }
          );
        } catch {
          setStatus({ kind: "error", reason: "Could not reach the viewer." });
        }
      });
    },
    [sampleFile]
  );

  const flush = useCallback(() => {
    for (const [id, timer] of timers.current) {
      window.clearTimeout(timer);
      persist(id);
    }
    timers.current.clear();
  }, [persist]);

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") {
        flush();
      }
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [flush]);

  const update = useCallback(
    (id: string, change: (draft: GradeDraft) => GradeDraft) => {
      const next = change(draftsRef.current[id] ?? emptyDraft());
      draftsRef.current = { ...draftsRef.current, [id]: next };
      setDrafts(draftsRef.current);
      setStatus({ kind: "pending" });
      const earlier = timers.current.get(id);
      if (earlier !== undefined) {
        window.clearTimeout(earlier);
      }
      timers.current.set(
        id,
        window.setTimeout(() => {
          timers.current.delete(id);
          persist(id);
        }, saveDelayMs)
      );
    },
    [persist]
  );

  const onCheck = useCallback(
    (id: string, checkId: string, grade: CheckGrade | undefined) =>
      update(id, (current) => ({
        ...current,
        checks:
          grade === undefined
            ? without(current.checks, checkId)
            : { ...current.checks, [checkId]: grade },
      })),
    [update]
  );

  const onRubric = useCallback(
    (id: string, rubricId: string, grade: RubricGrade | undefined) =>
      update(id, (current) => ({
        ...current,
        rubric:
          grade === undefined
            ? without(current.rubric, rubricId)
            : { ...current.rubric, [rubricId]: grade },
      })),
    [update]
  );

  const onNote = useCallback(
    (id: string, note: string) =>
      update(id, (current) => ({ ...current, note })),
    [update]
  );

  const select = useCallback(
    (position: number) => {
      flush();
      setIndex(position);
    },
    [flush]
  );

  const progress = sampleProgress(sample, drafts);
  const item = sample.items[index];
  if (item === undefined) {
    return (
      <p className="text-muted-foreground text-sm">
        This sample has no items to grade.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      <ProgressBar progress={progress} status={status} />
      <div className="grid gap-6 md:grid-cols-[14rem_1fr]">
        <ItemList
          drafts={drafts}
          index={index}
          items={sample.items}
          onSelect={select}
        />
        <ItemForm
          draft={drafts[item.id] ?? emptyDraft()}
          index={index}
          item={item}
          key={item.id}
          onCheck={onCheck}
          onNote={onNote}
          onRubric={onRubric}
          onSelect={select}
          total={sample.items.length}
        />
      </div>
    </div>
  );
}

function statusText(status: SaveStatus): string {
  switch (status.kind) {
    case "error":
      return `Not saved: ${status.reason}`;
    case "pending":
      return "Changes not saved yet";
    case "saved":
      return `Saved at ${new Date(status.at).toLocaleTimeString("en-US", { hour12: false })}`;
    case "saving":
      return "Saving…";
    default:
      return "Saves as you go";
  }
}

function ProgressBar({
  progress,
  status,
}: {
  progress: ReturnType<typeof sampleProgress>;
  status: SaveStatus;
}) {
  const share = progress.total === 0 ? 0 : progress.done / progress.total;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
        <p>
          <span className="font-mono">
            {progress.done} of {progress.total}
          </span>{" "}
          graded
          {progress.started > 0 ? `, ${progress.started} started` : ""}
        </p>
        <p
          aria-live="polite"
          className={
            status.kind === "error"
              ? "text-fail text-sm"
              : "text-muted-foreground text-sm"
          }
        >
          {statusText(status)}
        </p>
      </div>
      <div
        aria-label="Grading progress"
        aria-valuemax={progress.total}
        aria-valuemin={0}
        aria-valuenow={progress.done}
        className="bg-muted h-2 overflow-hidden rounded-full"
        role="progressbar"
        tabIndex={-1}
      >
        <div
          className="bg-primary h-full transition-[width]"
          style={{ width: `${share * 100}%` }}
        />
      </div>
    </div>
  );
}

function ItemList({
  drafts,
  index,
  items,
  onSelect,
}: {
  drafts: Drafts;
  index: number;
  items: CalibrationItem[];
  onSelect: (position: number) => void;
}) {
  return (
    <nav aria-label="Items" className="md:max-h-[75vh] md:overflow-y-auto">
      <ul className="flex flex-col gap-1">
        {items.map((entry, position) => (
          <ItemButton
            current={position === index}
            entry={entry}
            key={entry.id}
            onSelect={onSelect}
            position={position}
            state={itemState(entry, drafts[entry.id])}
          />
        ))}
      </ul>
    </nav>
  );
}

function ItemButton({
  current,
  entry,
  onSelect,
  position,
  state,
}: {
  current: boolean;
  entry: CalibrationItem;
  onSelect: (position: number) => void;
  position: number;
  state: ItemState;
}) {
  const handleClick = useCallback(
    () => onSelect(position),
    [onSelect, position]
  );
  return (
    <li>
      <button
        aria-current={current ? "true" : undefined}
        className="hover:bg-muted aria-[current=true]:bg-muted flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm"
        onClick={handleClick}
        type="button"
      >
        <span aria-hidden="true" className="font-mono">
          {stateMark[state]}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono">{entry.id}</span>
        <span className="text-muted-foreground truncate text-xs">
          {entry.expect.length > 0 ? entry.expect : entry.kind}
        </span>
        <span className="sr-only">{stateName[state]}</span>
      </button>
    </li>
  );
}

function ItemForm({
  draft,
  index,
  item,
  onCheck,
  onNote,
  onRubric,
  onSelect,
  total,
}: {
  draft: GradeDraft;
  index: number;
  item: CalibrationItem;
  onCheck: (id: string, checkId: string, grade: CheckGrade | undefined) => void;
  onNote: (id: string, note: string) => void;
  onRubric: (
    id: string,
    rubricId: string,
    grade: RubricGrade | undefined
  ) => void;
  onSelect: (position: number) => void;
  total: number;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-6">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-mono text-base font-medium">{item.id}</h2>
          {item.person.length > 0 ? (
            <Badge variant="outline">{item.person}</Badge>
          ) : null}
          {item.kind.length > 0 ? (
            <Badge variant="outline">{item.kind}</Badge>
          ) : null}
          {item.expect.length > 0 ? (
            <Badge variant="outline">expects {item.expect}</Badge>
          ) : null}
        </div>
        {item.itemId.length > 0 ? (
          <p className="text-muted-foreground font-mono text-xs">
            {item.itemId}
            {item.setupId.length > 0 ? ` · setup ${item.setupId}` : ""}
          </p>
        ) : null}
      </div>

      {item.context === undefined ? null : (
        <CalibrationContext context={item.context} />
      )}

      <div className="flex flex-col gap-1">
        <p className="text-muted-foreground text-xs">Person</p>
        <p className="bg-muted w-fit max-w-prose rounded-lg px-3 py-2 text-sm whitespace-pre-wrap">
          {item.message.length > 0 ? item.message : "(no message)"}
        </p>
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-muted-foreground text-xs">Sage's reply</p>
        <p className="text-sm whitespace-pre-wrap">
          {item.reply.length > 0 ? item.reply : "(no reply)"}
        </p>
      </div>

      {item.checks.length > 0 ? (
        <fieldset className="flex flex-col gap-4">
          <legend className="text-base font-medium">Checks</legend>
          <p className="text-muted-foreground -mt-2 text-sm">
            Pass when the sentence is true. N/A when the check does not apply.
          </p>
          {item.checks.map((id) => (
            <CheckQuestion
              grade={draft.checks[id]}
              id={id}
              itemId={item.id}
              key={id}
              onCheck={onCheck}
            />
          ))}
        </fieldset>
      ) : null}

      {item.rubric.length > 0 ? (
        <fieldset className="flex flex-col gap-4">
          <legend className="text-base font-medium">Rubric</legend>
          <p className="text-muted-foreground -mt-2 text-sm">
            1 to 5, and 5 means the sentence is fully true. N/A when it does not
            apply.
          </p>
          {item.rubric.map((id) => (
            <RubricQuestion
              grade={draft.rubric[id]}
              id={id}
              itemId={item.id}
              key={id}
              onRubric={onRubric}
            />
          ))}
        </fieldset>
      ) : null}

      <NoteField itemId={item.id} note={draft.note} onNote={onNote} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <StepButton
          disabled={index === 0}
          index={index}
          offset={-1}
          onSelect={onSelect}
          variant="outline"
        >
          Previous
        </StepButton>
        <span className="text-muted-foreground font-mono text-xs">
          {index + 1} of {total}
        </span>
        <StepButton
          disabled={index >= total - 1}
          index={index}
          offset={1}
          onSelect={onSelect}
          variant="default"
        >
          Next
        </StepButton>
      </div>
    </section>
  );
}

function StepButton({
  children,
  disabled,
  index,
  offset,
  onSelect,
  variant,
}: {
  children: ReactNode;
  disabled: boolean;
  index: number;
  offset: number;
  onSelect: (position: number) => void;
  variant: "default" | "outline";
}) {
  const handleClick = useCallback(
    () => onSelect(index + offset),
    [index, offset, onSelect]
  );
  return (
    <Button
      disabled={disabled}
      onClick={handleClick}
      type="button"
      variant={variant}
    >
      {children}
    </Button>
  );
}

function NoteField({
  itemId,
  note,
  onNote,
}: {
  itemId: string;
  note: string;
  onNote: (id: string, note: string) => void;
}) {
  const handleChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) =>
      onNote(itemId, event.target.value),
    [itemId, onNote]
  );
  return (
    <div className="flex flex-col gap-2">
      <label className="text-base font-medium" htmlFor={`note-${itemId}`}>
        Note
      </label>
      <Textarea
        id={`note-${itemId}`}
        maxLength={maxNoteLength}
        onChange={handleChange}
        placeholder="Why you graded it this way. Optional."
        value={note}
      />
    </div>
  );
}

function CheckQuestion({
  grade,
  id,
  itemId,
  onCheck,
}: {
  grade: CheckGrade | undefined;
  id: string;
  itemId: string;
  onCheck: (id: string, checkId: string, grade: CheckGrade | undefined) => void;
}) {
  const handleChange = useCallback(
    (next: string[]) => onCheck(itemId, id, checkFromValue(next[0])),
    [id, itemId, onCheck]
  );
  return (
    <Question
      hint={checkHint(id)}
      id={id}
      label={checkLabel(id)}
      onValueChange={handleChange}
      options={checkOptions}
      tier={tierLabel[checkTier(id)]}
      value={checkValue(grade)}
    />
  );
}

function RubricQuestion({
  grade,
  id,
  itemId,
  onRubric,
}: {
  grade: RubricGrade | undefined;
  id: string;
  itemId: string;
  onRubric: (
    id: string,
    rubricId: string,
    grade: RubricGrade | undefined
  ) => void;
}) {
  const handleChange = useCallback(
    (next: string[]) => onRubric(itemId, id, rubricFromValue(next[0])),
    [id, itemId, onRubric]
  );
  return (
    <Question
      hint={checkHint(id)}
      id={id}
      label={checkLabel(id)}
      onValueChange={handleChange}
      options={rubricOptions}
      tier={tierLabel[checkTier(id)]}
      value={rubricValue(grade)}
    />
  );
}

function Question({
  hint,
  id,
  label,
  onValueChange,
  options,
  tier,
  value,
}: {
  hint: string;
  id: string;
  label: string;
  onValueChange: (next: string[]) => void;
  options: Option[];
  tier: string;
  value: string[];
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{tier}</Badge>
        <span className="text-sm font-medium">{label}</span>
      </div>
      {hint.length > 0 ? (
        <p className="text-muted-foreground text-sm">{hint}</p>
      ) : null}
      <ToggleGroup
        aria-label={label}
        data-check={id}
        onValueChange={onValueChange}
        spacing={1}
        value={value}
        variant="outline"
      >
        {options.map((option) => (
          <ToggleGroupItem
            className="data-pressed:bg-primary data-pressed:text-primary-foreground data-pressed:hover:bg-primary/90"
            key={option.value}
            value={option.value}
          >
            {option.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}
