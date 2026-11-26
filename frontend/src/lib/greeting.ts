// The new chat greets you by the time of day. It turns over at 5 AM, noon,
// and 5 PM, and the date above it turns over at midnight.

const morningStartsAt = 5;
const afternoonStartsAt = 12;
const eveningStartsAt = 17;
const greetingHours = [morningStartsAt, afternoonStartsAt, eveningStartsAt];

export function greetingFor(now = new Date()): string {
  const hour = now.getHours();
  if (hour >= eveningStartsAt || hour < morningStartsAt) {
    return "Good evening.";
  }
  return hour < afternoonStartsAt ? "Good morning." : "Good afternoon.";
}

/** The next moment the greeting turns over: 5 AM, noon, or 5 PM. */
export function nextGreetingChange(now = new Date()): Date {
  for (const hour of greetingHours) {
    const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour);
    if (at.getTime() > now.getTime()) {
      return at;
    }
  }
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
    morningStartsAt
  );
}

/** The next moment the greeting or the date can turn over. */
export function nextGreetingTick(now = new Date()): Date {
  const midnight = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1
  );
  const greeting = nextGreetingChange(now);
  return greeting.getTime() < midnight.getTime() ? greeting : midnight;
}
