const std = @import("std");
const native_sdk = @import("native_sdk");
const journal = @import("journal.zig");
const ollama = @import("ollama.zig");

const status_timeout_ms = 10_000;
const generate_timeout_ms = 120_000;
const summarize_timeout_ms = 300_000;

const SpawnResult = enum { spawned, skipped, failed };

pub const Queue = struct {
    mutex: std.Io.Mutex = .init,
    jobs: std.ArrayList(*Job) = .empty,

    pub fn push(self: *Queue, io: std.Io, job: *Job) void {
        self.mutex.lockUncancelable(io);
        defer self.mutex.unlock(io);
        self.jobs.append(std.heap.page_allocator, job) catch {};
    }

    pub fn takeAll(self: *Queue, io: std.Io) []*Job {
        self.mutex.lockUncancelable(io);
        defer self.mutex.unlock(io);
        const done = std.heap.page_allocator.dupe(*Job, self.jobs.items) catch return &.{};
        self.jobs.clearRetainingCapacity();
        return done;
    }
};

pub const Runner = struct {
    checking: bool = false,
    running: bool = false,
    done: usize = 0,
    total: usize = 0,
    facts: usize = 0,
    events: usize = 0,
    failures: usize = 0,
    generation: u64 = 0,
    epoch: u64 = 0,
    items: []journal.DreamItem = &.{},
    next_index: usize = 0,
    in_flight: bool = false,
    start_responder: ?native_sdk.bridge.AsyncResponder = null,
    start_request_id: []u8 = &.{},

    pub fn busy(self: *const Runner) bool {
        return self.checking or self.running;
    }

    pub fn writeStatus(self: *const Runner, last_dreamed_at: []const u8, output: []u8) ![]const u8 {
        var writer = std.Io.Writer.fixed(output);
        try writer.writeAll("{\"running\":");
        try writer.writeAll(if (self.busy()) "true" else "false");
        try writer.writeAll(",\"done\":");
        try writer.print("{d}", .{self.done});
        try writer.writeAll(",\"total\":");
        try writer.print("{d}", .{self.total});
        try writer.writeAll(",\"lastDreamedAt\":");
        if (last_dreamed_at.len == 0) {
            try writer.writeAll("null");
        } else {
            try journal.writeJsonStringStreaming(&writer, last_dreamed_at);
        }
        try writer.writeByte('}');
        return writer.buffered();
    }
};

pub const Host = struct {
    store: *journal.Store,
    io: std.Io,
    queue: *Queue,
    runner: *Runner,
    services: ?native_sdk.platform.PlatformServices,
    runtime: ?*native_sdk.Runtime,
    models: ollama.ModelPrefixes = .{},
    memory_enabled: bool = false,

    fn emit(self: Host, name: []const u8, payload: []const u8) void {
        const runtime = self.runtime orelse return;
        runtime.emitWindowEvent(1, name, payload) catch {};
    }

    fn allocator(self: Host) std.mem.Allocator {
        return self.store.allocator;
    }
};

pub const Job = struct {
    kind: Kind,
    epoch: u64 = 0,
    source: journal.DreamSource = .entry,
    source_id: i64 = 0,
    source_date: []u8 = &.{},
    text: []u8 = &.{},
    recent_text: []u8 = &.{},
    need_embed: bool = false,
    need_summary: bool = false,
    need_title: bool = false,
    extract_memory: bool = false,
    chunks: [][]const u8 = &.{},
    vectors: [][]f32 = &.{},
    summary: []u8 = &.{},
    summary_vector: []f32 = &.{},
    title: []u8 = &.{},
    extraction: ollama.Extraction = .{},
    memory_vectors: [][]f32 = &.{},
    fact_vectors: [][]f32 = &.{},
    event_vectors: [][]f32 = &.{},
    model_name: []const u8 = "",
    summary_model_name: []const u8 = "",
    err: ?anyerror = null,
    generation: u64 = 0,

    const Kind = enum { status, item };
};

pub fn start(host: Host, responder: native_sdk.bridge.AsyncResponder, request_id: []const u8) !void {
    const runner = host.runner;
    if (runner.busy()) return error.DreamInProgress;
    const services = host.services orelse return error.RuntimeUnavailable;
    const allocator = host.allocator();
    const owned_id = try allocator.dupe(u8, request_id);
    errdefer allocator.free(owned_id);
    const job = try allocator.create(Job);
    errdefer allocator.destroy(job);
    runner.epoch += 1;
    job.* = .{
        .kind = .status,
        .epoch = runner.epoch,
    };
    runner.checking = true;
    runner.start_responder = responder;
    runner.start_request_id = owned_id;
    const thread = std.Thread.spawn(.{}, runStatusJob, .{ host.io, allocator, host.queue, services, job, host.models }) catch |err| {
        runner.checking = false;
        runner.start_responder = null;
        runner.start_request_id = &.{};
        return err;
    };
    thread.detach();
}

pub fn drain(host: Host) void {
    const jobs = host.queue.takeAll(host.io);
    defer if (jobs.len > 0) std.heap.page_allocator.free(jobs);
    for (jobs) |job| complete(host, job);
}

pub fn abort(host: Host, message: []const u8) void {
    const runner = host.runner;
    if (!runner.busy()) return;
    runner.epoch += 1;
    if (runner.start_responder != null) {
        failStart(host, message);
        resetRunner(host);
        return;
    }
    finish(host, false, message);
}

/// Stop a running Dream without a window event. Used when Delete All Data
/// already tells the user the journal was wiped.
pub fn abortSilent(host: Host) void {
    const runner = host.runner;
    if (!runner.busy()) return;
    runner.epoch += 1;
    if (runner.start_responder != null) {
        failStart(host, "Journal data was deleted.");
        resetRunner(host);
        return;
    }
    resetRunner(host);
}

fn runStatusJob(
    io: std.Io,
    allocator: std.mem.Allocator,
    queue: *Queue,
    services: native_sdk.platform.PlatformServices,
    job: *Job,
    models: ollama.ModelPrefixes,
) void {
    var abort_handle: ollama.Abort = .{ .io = io };
    const watchdog = ollama.startWatchdog(&abort_handle, status_timeout_ms);
    const status = ollama.checkSummaryStatus(io, allocator, &abort_handle, models);
    ollama.finishWatchdog(&abort_handle, watchdog);
    if (!status.running) {
        job.err = error.OllamaNotRunning;
        freeStatusNames(allocator, status);
    } else {
        job.model_name = status.embed_model_name;
        job.summary_model_name = status.summary_model_name;
    }
    queue.push(io, job);
    services.wake() catch {};
}

fn itemNeedsSummaryModel(job: *const Job) bool {
    return job.need_summary or job.need_title or job.extract_memory;
}

fn itemNeedsEmbeddingModel(job: *const Job) bool {
    return job.need_embed or job.need_summary or job.extract_memory;
}

fn runItemJob(
    io: std.Io,
    allocator: std.mem.Allocator,
    queue: *Queue,
    services: native_sdk.platform.PlatformServices,
    job: *Job,
    models: ollama.ModelPrefixes,
) void {
    var status_abort: ollama.Abort = .{ .io = io };
    const status_watchdog = ollama.startWatchdog(&status_abort, status_timeout_ms);
    const status = ollama.checkSummaryStatus(io, allocator, &status_abort, models);
    ollama.finishWatchdog(&status_abort, status_watchdog);
    if (!status.running) {
        job.err = error.OllamaNotRunning;
        freeStatusNames(allocator, status);
    } else if (itemNeedsSummaryModel(job) and (!status.summary_pulled or status.summary_model_name.len == 0)) {
        job.err = error.SummaryModelNotPulled;
        freeStatusNames(allocator, status);
    } else if (itemNeedsEmbeddingModel(job) and (!status.embed_pulled or status.embed_model_name.len == 0)) {
        job.err = error.ModelNotPulled;
        freeStatusNames(allocator, status);
    } else {
        job.model_name = status.embed_model_name;
        job.summary_model_name = status.summary_model_name;
        runItemPhases(io, allocator, job) catch |err| {
            job.err = err;
        };
    }
    queue.push(io, job);
    services.wake() catch {};
}

fn runItemPhases(io: std.Io, allocator: std.mem.Allocator, job: *Job) !void {
    if (job.need_embed) {
        const chunks = try ollama.chunkText(allocator, job.text);
        job.chunks = chunks;
        if (chunks.len > 0) {
            var embed_abort: ollama.Abort = .{ .io = io };
            const embed_watchdog = ollama.startWatchdog(&embed_abort, generate_timeout_ms);
            const vectors = ollama.embed(io, allocator, chunks, job.model_name, &embed_abort);
            ollama.finishWatchdog(&embed_abort, embed_watchdog);
            job.vectors = try vectors;
        }
    }

    if (job.need_summary) {
        var summarize_abort: ollama.Abort = .{ .io = io };
        const summarize_watchdog = ollama.startWatchdog(&summarize_abort, summarize_timeout_ms);
        const summary = switch (job.source) {
            .entry => ollama.summarize(io, allocator, job.text, job.summary_model_name, &summarize_abort),
            .conversation => ollama.summarizeChat(io, allocator, job.text, job.summary_model_name, &summarize_abort),
        };
        ollama.finishWatchdog(&summarize_abort, summarize_watchdog);
        job.summary = try summary;
        const chunks = [_][]const u8{job.summary};
        var embed_abort: ollama.Abort = .{ .io = io };
        const embed_watchdog = ollama.startWatchdog(&embed_abort, generate_timeout_ms);
        const vectors = ollama.embed(io, allocator, &chunks, job.model_name, &embed_abort);
        ollama.finishWatchdog(&embed_abort, embed_watchdog);
        const owned = try vectors;
        if (owned.len == 0) {
            allocator.free(owned);
            return error.InvalidEmbedding;
        }
        job.summary_vector = owned[0];
        allocator.free(owned);
    }

    if (job.extract_memory) {
        var extract_abort: ollama.Abort = .{ .io = io };
        const extract_watchdog = ollama.startWatchdog(&extract_abort, summarize_timeout_ms);
        const extraction = ollama.extract(io, allocator, job.text, job.summary_model_name, &extract_abort);
        ollama.finishWatchdog(&extract_abort, extract_watchdog);
        job.extraction = try extraction;
    }

    if (job.need_title) {
        const trimmed_recent = std.mem.trim(u8, job.recent_text, " \t\r\n");
        if (trimmed_recent.len > 0) {
            var title_abort: ollama.Abort = .{ .io = io };
            const title_watchdog = ollama.startWatchdog(&title_abort, generate_timeout_ms);
            const titled = ollama.titleChat(io, allocator, job.recent_text, job.summary_model_name, &title_abort);
            ollama.finishWatchdog(&title_abort, title_watchdog);
            if (titled) |value| {
                job.title = value;
            } else |_| {}
        }
    }

    if (!job.extract_memory) return;

    var embed_texts = std.ArrayList([]const u8).empty;
    defer embed_texts.deinit(allocator);
    for (job.extraction.facts) |item| try embed_texts.append(allocator, item.fact);
    const fact_count = embed_texts.items.len;
    for (job.extraction.events) |item| try embed_texts.append(allocator, item.event);
    if (embed_texts.items.len == 0) return;

    var embed_abort: ollama.Abort = .{ .io = io };
    const embed_watchdog = ollama.startWatchdog(&embed_abort, generate_timeout_ms);
    const vectors = ollama.embed(io, allocator, embed_texts.items, job.model_name, &embed_abort);
    ollama.finishWatchdog(&embed_abort, embed_watchdog);
    const owned = try vectors;
    if (owned.len != embed_texts.items.len) {
        for (owned) |vec| allocator.free(vec);
        allocator.free(owned);
        return error.EmbeddingCountMismatch;
    }
    job.memory_vectors = owned;
    job.fact_vectors = owned[0..fact_count];
    job.event_vectors = owned[fact_count..];
}

fn complete(host: Host, job: *Job) void {
    const allocator = host.allocator();
    defer destroyJob(allocator, job);
    if (job.epoch != host.runner.epoch) return;
    switch (job.kind) {
        .status => completeStatus(host, job),
        .item => completeItem(host, job),
    }
}

fn completeStatus(host: Host, job: *Job) void {
    const runner = host.runner;
    runner.checking = false;
    if (job.err) |err| {
        var pulled_buf: [256]u8 = undefined;
        failStart(host, statusMessage(err, host.models, &pulled_buf));
        return;
    }
    const items = host.store.listPendingDream(host.memory_enabled) catch {
        failStart(host, "Could not look up what to dream.");
        return;
    };
    runner.items = items;
    runner.total = items.len;
    runner.done = 0;
    runner.facts = 0;
    runner.events = 0;
    runner.failures = 0;
    runner.next_index = 0;
    runner.generation = host.store.data_generation;
    runner.running = true;
    emitStarted(host, items.len);
    succeedStart(host, items.len);
    processNext(host);
}

fn completeItem(host: Host, job: *Job) void {
    const runner = host.runner;
    runner.in_flight = false;
    if (!runner.running) return;
    if (job.generation != host.store.data_generation) {
        abort(host, "Journal data was deleted.");
        return;
    }
    if (job.err) |_| {
        runner.failures += 1;
    } else {
        const written = writeItem(host.store, job) catch {
            runner.failures += 1;
            runner.done += 1;
            emitProgress(host);
            processNext(host);
            return;
        };
        runner.facts += written.facts;
        runner.events += written.events;
    }
    runner.done += 1;
    emitProgress(host);
    processNext(host);
}

fn processNext(host: Host) void {
    const runner = host.runner;
    while (runner.running and !runner.in_flight) {
        if (runner.next_index >= runner.items.len) {
            finish(host, true, "");
            return;
        }
        const item = runner.items[runner.next_index];
        runner.next_index += 1;
        switch (spawnItem(host, item)) {
            .spawned => return,
            .skipped => {
                runner.done += 1;
                emitProgress(host);
            },
            .failed => {
                runner.failures += 1;
                runner.done += 1;
                emitProgress(host);
            },
        }
    }
}

fn spawnItem(host: Host, item: journal.DreamItem) SpawnResult {
    const services = host.services orelse return .failed;
    const allocator = host.allocator();
    var text: []u8 = &.{};
    var date: []u8 = &.{};
    var recent: []u8 = &.{};
    var need_embed = false;
    var need_summary = false;
    var need_title = false;
    const extract_memory = host.memory_enabled and item.needs_memory_extraction;
    switch (item.source) {
        .entry => {
            const loaded = host.store.loadBody(item.id) catch |err| switch (err) {
                error.NotFound => return .skipped,
                else => return .failed,
            };
            defer allocator.free(loaded.format);
            defer allocator.free(loaded.body);
            date = host.store.entryDate(item.id) catch |err| switch (err) {
                error.NotFound => return .skipped,
                else => return .failed,
            };
            text = ollama.extractPlainText(allocator, loaded.body, loaded.format) catch {
                allocator.free(date);
                return .failed;
            };
            need_embed = host.store.entryEmbeddingsStale(item.id) catch {
                allocator.free(text);
                allocator.free(date);
                return .failed;
            };
            need_summary = host.store.entrySummaryStale(item.id) catch {
                allocator.free(text);
                allocator.free(date);
                return .failed;
            };
        },
        .conversation => {
            const loaded = host.store.loadConversationText(item.id) catch |err| switch (err) {
                error.NotFound => return .skipped,
                else => return .failed,
            };
            text = loaded.text;
            date = loaded.date;
            recent = loaded.recent;
            need_title = item.needs_memory_extraction and !loaded.title_locked;
            if (host.memory_enabled) {
                need_embed = host.store.chatEmbeddingsStale(item.id) catch {
                    freeLoaded(allocator, text, date, recent);
                    return .failed;
                };
                need_summary = host.store.chatSummaryStale(item.id) catch {
                    freeLoaded(allocator, text, date, recent);
                    return .failed;
                };
            }
        },
    }

    const trimmed = std.mem.trim(u8, text, " \t\r\n");
    if (trimmed.len == 0) {
        freeLoaded(allocator, text, date, recent);
        if (item.source == .conversation) {
            host.store.markChatIndexSkipped(item.id) catch return .failed;
        }
        host.store.markDreamed(item.source, item.id) catch return .failed;
        return .skipped;
    }

    if (!need_title or std.mem.trim(u8, recent, " \t\r\n").len == 0) {
        if (recent.len > 0) allocator.free(recent);
        recent = &.{};
        need_title = false;
    }

    if (!extract_memory and !need_embed and !need_summary and !need_title) {
        freeLoaded(allocator, text, date, recent);
        host.store.markDreamed(item.source, item.id) catch return .failed;
        return .skipped;
    }

    const job = allocator.create(Job) catch {
        freeLoaded(allocator, text, date, recent);
        return .failed;
    };
    job.* = .{
        .kind = .item,
        .epoch = host.runner.epoch,
        .source = item.source,
        .source_id = item.id,
        .source_date = date,
        .text = text,
        .recent_text = recent,
        .need_embed = need_embed,
        .need_summary = need_summary,
        .need_title = need_title,
        .extract_memory = extract_memory,
        .generation = host.runner.generation,
    };
    host.runner.in_flight = true;
    const thread = std.Thread.spawn(.{}, runItemJob, .{ host.io, allocator, host.queue, services, job, host.models }) catch {
        host.runner.in_flight = false;
        destroyJob(allocator, job);
        return .failed;
    };
    thread.detach();
    return .spawned;
}

fn freeLoaded(allocator: std.mem.Allocator, text: []u8, date: []u8, recent: []u8) void {
    if (text.len > 0) allocator.free(text);
    if (date.len > 0) allocator.free(date);
    if (recent.len > 0) allocator.free(recent);
}

fn writeItem(store: *journal.Store, job: *Job) !struct { facts: usize, events: usize } {
    if (!try store.sourceExists(job.source, job.source_id)) {
        return .{ .facts = 0, .events = 0 };
    }
    if (job.source == .conversation and job.title.len > 0) {
        store.applyDreamChatTitle(job.source_id, job.title) catch {};
    }
    if (job.need_embed and job.chunks.len > 0) {
        switch (job.source) {
            .entry => try store.replaceEmbeddings(job.source_id, job.chunks, job.vectors, job.model_name),
            .conversation => try store.replaceChatEmbeddings(job.source_id, job.chunks, job.vectors, job.model_name),
        }
    }
    if (job.need_summary and job.summary.len > 0 and job.summary_vector.len > 0) {
        switch (job.source) {
            .entry => try store.replaceSummary(job.source_id, job.summary, job.summary_vector, job.summary_model_name, job.model_name),
            .conversation => try store.replaceChatSummary(job.source_id, job.summary, job.summary_vector, job.summary_model_name, job.model_name),
        }
    }
    if (!job.extract_memory) {
        try store.markDreamed(job.source, job.source_id);
        return .{ .facts = 0, .events = 0 };
    }

    const fallback_date = if (job.source_date.len > 0) job.source_date else "unknown";
    var facts = std.ArrayList(journal.NewFact).empty;
    defer facts.deinit(store.allocator);
    for (job.extraction.profile) |item| {
        try facts.append(store.allocator, .{
            .kind = "profile",
            .subject = "user",
            .fact = item,
            .embedding = null,
        });
    }
    if (job.fact_vectors.len != job.extraction.facts.len) return error.EmbeddingCountMismatch;
    for (job.extraction.facts, job.fact_vectors) |item, vec| {
        try facts.append(store.allocator, .{
            .kind = "fact",
            .subject = item.subject,
            .fact = item.fact,
            .embedding = vec,
        });
    }
    if (job.event_vectors.len != job.extraction.events.len) return error.EmbeddingCountMismatch;
    var events = std.ArrayList(journal.NewEvent).empty;
    defer events.deinit(store.allocator);
    for (job.extraction.events, job.event_vectors) |item, vec| {
        const occurred_at = if (item.date.len > 0) item.date else fallback_date;
        try events.append(store.allocator, .{
            .event = item.event,
            .occurred_at = occurred_at,
            .embedding = vec,
        });
    }
    const written = try store.commitDreamMemory(job.source, job.source_id, facts.items, events.items, job.model_name);
    return .{ .facts = written.facts, .events = written.events };
}

fn succeedStart(host: Host, total: usize) void {
    const runner = host.runner;
    const responder = runner.start_responder orelse return;
    const request_id = runner.start_request_id;
    runner.start_responder = null;
    runner.start_request_id = &.{};
    defer host.allocator().free(request_id);
    var buffer: [96]u8 = undefined;
    const body = std.fmt.bufPrint(&buffer, "{{\"ok\":true,\"total\":{d}}}", .{total}) catch "{\"ok\":true}";
    responder.success(request_id, body) catch {};
}

fn failStart(host: Host, message: []const u8) void {
    const runner = host.runner;
    const responder = runner.start_responder orelse return;
    const request_id = runner.start_request_id;
    runner.start_responder = null;
    runner.start_request_id = &.{};
    defer host.allocator().free(request_id);
    responder.fail(request_id, .handler_failed, message) catch {};
}

fn finish(host: Host, ok: bool, message: []const u8) void {
    const runner = host.runner;
    const facts = runner.facts;
    const events = runner.events;
    const failures = runner.failures;
    resetRunner(host);
    if (ok) {
        emitFinished(host, facts, events, failures);
    } else {
        emitFailed(host, message);
    }
}

fn resetRunner(host: Host) void {
    const runner = host.runner;
    const allocator = host.allocator();
    const epoch = runner.epoch;
    if (runner.items.len > 0) allocator.free(runner.items);
    if (runner.start_request_id.len > 0) allocator.free(runner.start_request_id);
    runner.* = .{
        .epoch = epoch,
    };
}

fn emitStarted(host: Host, total: usize) void {
    var buffer: [64]u8 = undefined;
    const payload = std.fmt.bufPrint(&buffer, "{{\"total\":{d}}}", .{total}) catch "{\"total\":0}";
    host.emit("dream:started", payload);
}

fn emitProgress(host: Host) void {
    var buffer: [96]u8 = undefined;
    const payload = std.fmt.bufPrint(&buffer, "{{\"done\":{d},\"total\":{d}}}", .{ host.runner.done, host.runner.total }) catch "{\"done\":0,\"total\":0}";
    host.emit("dream:progress", payload);
}

fn emitFinished(host: Host, facts: usize, events: usize, failures: usize) void {
    var buffer: [128]u8 = undefined;
    const payload = std.fmt.bufPrint(
        &buffer,
        "{{\"facts\":{d},\"events\":{d},\"failures\":{d}}}",
        .{ facts, events, failures },
    ) catch "{\"facts\":0,\"events\":0,\"failures\":0}";
    host.emit("dream:finished", payload);
}

fn emitFailed(host: Host, message: []const u8) void {
    var buffer: [512]u8 = undefined;
    var writer = std.Io.Writer.fixed(&buffer);
    writer.writeAll("{\"message\":") catch return;
    journal.writeJsonStringStreaming(&writer, message) catch return;
    writer.writeByte('}') catch return;
    host.emit("dream:failed", writer.buffered());
}

fn statusMessage(err: anyerror, models: ollama.ModelPrefixes, buffer: []u8) []const u8 {
    return switch (err) {
        error.OllamaNotRunning => "Ollama is not running.",
        error.SummaryModelNotPulled => ollama.summaryNotPulledMessage(buffer, models.summary),
        error.ModelNotPulled => ollama.embedNotPulledMessage(buffer, models.embed),
        error.OllamaTimeout => "Ollama did not answer in time.",
        else => "Could not start dreaming.",
    };
}

fn freeStatusNames(allocator: std.mem.Allocator, status: ollama.SummaryStatus) void {
    if (status.embed_model_name.len > 0) allocator.free(status.embed_model_name);
    if (status.summary_model_name.len > 0) allocator.free(status.summary_model_name);
}

fn destroyJob(allocator: std.mem.Allocator, job: *Job) void {
    if (job.source_date.len > 0) allocator.free(job.source_date);
    if (job.text.len > 0) allocator.free(job.text);
    if (job.recent_text.len > 0) allocator.free(job.recent_text);
    for (job.chunks) |chunk| allocator.free(chunk);
    if (job.chunks.len > 0) allocator.free(job.chunks);
    for (job.vectors) |vec| allocator.free(vec);
    if (job.vectors.len > 0) allocator.free(job.vectors);
    if (job.summary.len > 0) allocator.free(job.summary);
    if (job.summary_vector.len > 0) allocator.free(job.summary_vector);
    if (job.title.len > 0) allocator.free(job.title);
    job.extraction.deinit(allocator);
    for (job.memory_vectors) |vec| allocator.free(vec);
    if (job.memory_vectors.len > 0) allocator.free(job.memory_vectors);
    if (job.model_name.len > 0) allocator.free(job.model_name);
    if (job.summary_model_name.len > 0) allocator.free(job.summary_model_name);
    allocator.destroy(job);
}

test "Dream index and memory work require the right models" {
    const title_only = Job{
        .kind = .item,
        .need_title = true,
    };
    try std.testing.expect(itemNeedsSummaryModel(&title_only));
    try std.testing.expect(!itemNeedsEmbeddingModel(&title_only));

    const journal_index = Job{
        .kind = .item,
        .need_embed = true,
    };
    try std.testing.expect(!itemNeedsSummaryModel(&journal_index));
    try std.testing.expect(itemNeedsEmbeddingModel(&journal_index));

    const index_only_summary = Job{
        .kind = .item,
        .need_summary = true,
    };
    try std.testing.expect(itemNeedsSummaryModel(&index_only_summary));
    try std.testing.expect(itemNeedsEmbeddingModel(&index_only_summary));
    try std.testing.expect(!index_only_summary.extract_memory);

    const memory_extraction = Job{
        .kind = .item,
        .extract_memory = true,
    };
    try std.testing.expect(itemNeedsSummaryModel(&memory_extraction));
    try std.testing.expect(itemNeedsEmbeddingModel(&memory_extraction));
}

test "index-only Dream repairs a summary without replacing memories" {
    const open_result = try native_sdk.RelationalStore.openMemoryMigrated(std.testing.allocator, &journal.migrations);
    var db = switch (open_result.outcome) {
        .ok => open_result.database.?,
        else => return error.SqliteMigrationFailed,
    };
    try journal.insertFixtureEntries(&db);
    var store = journal.Store.init(std.testing.allocator, db);
    defer store.deinit();

    const facts = [_]journal.NewFact{.{
        .kind = "profile",
        .subject = "user",
        .fact = "Keeps a journal",
        .embedding = null,
    }};
    _ = try store.commitDreamMemory(.entry, 1, &facts, &.{}, "nomic-embed-text:v1.5");

    const summary = try std.testing.allocator.dupe(u8, "A refreshed summary.");
    defer std.testing.allocator.free(summary);
    var vector = [_]f32{ 0.1, 0.2, 0.3 };
    var job = Job{
        .kind = .item,
        .source = .entry,
        .source_id = 1,
        .need_summary = true,
        .summary = summary,
        .summary_vector = &vector,
        .summary_model_name = "qwen3:8b",
        .model_name = "nomic-embed-text:v1.5",
    };
    const written = try writeItem(&store, &job);
    try std.testing.expectEqual(@as(usize, 0), written.facts);
    try std.testing.expectEqual(@as(usize, 0), written.events);
    try std.testing.expect(!(try store.entrySummaryStale(1)));

    var profile_out: [1024]u8 = undefined;
    var profile_writer = std.Io.Writer.fixed(&profile_out);
    try store.listProfile(journal.profile_recall_limit, &profile_writer);
    try std.testing.expect(std.mem.indexOf(u8, profile_writer.buffered(), "Keeps a journal") != null);
}

test "status json names running done total and lastDreamedAt" {
    var runner: Runner = .{ .running = true, .done = 2, .total = 5 };
    var buffer: [128]u8 = undefined;
    const json = try runner.writeStatus("2026-09-14T18:00:00.000Z", &buffer);
    try std.testing.expectEqualStrings(
        "{\"running\":true,\"done\":2,\"total\":5,\"lastDreamedAt\":\"2026-09-14T18:00:00.000Z\"}",
        json,
    );
}

test "status json treats a model check as running" {
    var runner: Runner = .{ .checking = true };
    var buffer: [96]u8 = undefined;
    const json = try runner.writeStatus("", &buffer);
    try std.testing.expectEqualStrings(
        "{\"running\":true,\"done\":0,\"total\":0,\"lastDreamedAt\":null}",
        json,
    );
}
