/**
 * The typed call surface.
 *
 * This is type-level only, deliberately. At runtime a proxy method is exactly
 * `bridge.call("<service>.<method>", ...args)` — the same string-keyed call,
 * with the same JSON encoding — so there is no second dispatch path to keep in
 * step. What the proxy adds is the shape of the service as the host declared
 * it, which is enough to catch a renamed method or a wrong argument at compile
 * time.
 *
 * End-to-end inference from a real router, including inferred return types
 * across a network boundary, is the job of `@brobridgejs/adapters`.
 */

/** Any callable, for filtering a service interface down to its methods. */
type AnyMethod = (...args: never[]) => unknown;

/**
 * A service interface mapped onto the shape the bridge exposes: every method
 * returns a promise, and non-method members are dropped.
 */
export type RemoteService<T> = {
  [K in keyof T as T[K] extends AnyMethod ? K : never]: T[K] extends (
    ...args: infer A
  ) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
};

/** What {@link makeProxy} needs: the one call it forwards to. */
export interface ProxyTarget {
  call<T>(route: string, ...args: readonly unknown[]): Promise<T>;
}

/**
 * Build a proxy for one exposed service.
 *
 * Only string properties resolve to calls. `then` in particular does not:
 * a proxy that answered `then` with a function would look like a thenable, and
 * `await bridge.makeProxy(...)` would call a method named `then` on the host.
 */
export function makeProxy<T>(target: ProxyTarget, service: string): RemoteService<T> {
  return new Proxy(Object.create(null) as RemoteService<T>, {
    get(_object, property): unknown {
      if (typeof property !== 'string' || property === 'then') return undefined;
      return (...args: readonly unknown[]): Promise<unknown> =>
        target.call(`${service}.${property}`, ...args);
    },
  });
}
