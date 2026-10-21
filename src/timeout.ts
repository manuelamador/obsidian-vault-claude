/**
 * `promise`, or the error `timedOut` gives if it has not settled within `ms`. `timedOut` runs once, as
 * time runs out: where what was waited on is given up (a request forgotten, a turn interrupted).
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, timedOut: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(timedOut()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
