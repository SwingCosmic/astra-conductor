export type ClassConstructor = new (...args: never[]) => object;
export type ServiceSlice<TBase extends ClassConstructor = ClassConstructor> = {
  (base: TBase): ClassConstructor;
  readonly members: readonly string[];
};
type UnionToIntersection<T> = (T extends unknown ? (value: T) => void : never) extends (
  value: infer I,
) => void
  ? I
  : never;
type MixedInstance<
  TBase extends ClassConstructor,
  TSlices extends readonly ServiceSlice<TBase>[],
> = InstanceType<TBase> & UnionToIntersection<InstanceType<ReturnType<TSlices[number]>>>;

/** Each factory declares public members; ordering cannot resolve ownership conflicts. */
export function defineServiceSlice<
  TBase extends ClassConstructor,
  TResult extends ClassConstructor,
>(
  members: readonly string[],
  factory: (base: TBase) => TResult,
): ((base: TBase) => TResult) & { readonly members: readonly string[] } {
  return Object.assign(factory, { members: Object.freeze([...members]) });
}

export function mixin<
  TBase extends ClassConstructor,
  const TSlices extends readonly ServiceSlice<TBase>[],
>(
  Base: TBase,
  ...slices: TSlices
): new (...args: ConstructorParameters<TBase>) => MixedInstance<TBase, TSlices> {
  const owners = new Set<string>(["waitForEvents", "dispose"]);
  for (
    let prototype = Base.prototype;
    prototype && prototype !== Object.prototype;
    prototype = Object.getPrototypeOf(prototype)
  ) {
    for (const name of Object.getOwnPropertyNames(prototype))
      if (name !== "constructor") owners.add(name);
  }
  let result: ClassConstructor = Base;
  for (const slice of slices) {
    for (const member of slice.members) {
      if (owners.has(member)) throw new Error(`Service member has multiple owners: ${member}`);
      owners.add(member);
    }
    const next = slice(result as TBase);
    if (!(next.prototype instanceof result))
      throw new Error("Service slices must extend their supplied base class");
    result = next;
  }
  return result as unknown as new (
    ...args: ConstructorParameters<TBase>
  ) => MixedInstance<TBase, TSlices>;
}
