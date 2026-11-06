/** An exact non-negative .NET decimal, carried as a JSON number only at API-level boundaries. */
export class ApiDecimal {
  private constructor(
    readonly coefficient: bigint,
    readonly scale: number,
  ) {}

  static parse(source: string): ApiDecimal {
    const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(source);
    if (!match) throw new RangeError("invalid-api-level");
    if (match[1] === "-") throw new RangeError("invalid-api-level");
    const fraction = match[3] ?? "";
    let digits = (match[2]! + fraction).replace(/^0+/, "");
    if (!digits) return new ApiDecimal(0n, 0);
    const exponent = BigInt(match[4] ?? "0");
    let scale = BigInt(fraction.length) - exponent;
    const trailing = /0+$/.exec(digits)?.[0].length ?? 0;
    if (trailing) {
      digits = digits.slice(0, -trailing);
      scale -= BigInt(trailing);
    }
    if (scale < 0n) {
      if (BigInt(digits.length) - scale > 29n) throw new RangeError("invalid-api-level");
      digits += "0".repeat(Number(-scale));
      scale = 0n;
    }
    if (scale > 28n || digits.length > 29) throw new RangeError("invalid-api-level");
    const coefficient = BigInt(digits);
    if (coefficient > 79228162514264337593543950335n) throw new RangeError("invalid-api-level");
    return new ApiDecimal(coefficient, Number(scale));
  }

  toString(): string {
    const digits = this.coefficient.toString().padStart(this.scale + 1, "0");
    return this.scale ? `${digits.slice(0, -this.scale)}.${digits.slice(-this.scale)}` : digits;
  }

  compare(other: ApiDecimal): -1 | 0 | 1 {
    const scale = Math.max(this.scale, other.scale);
    const left = this.coefficient * 10n ** BigInt(scale - this.scale);
    const right = other.coefficient * 10n ** BigInt(scale - other.scale);
    return left < right ? -1 : left > right ? 1 : 0;
  }
}

export function asApiDecimal(value: unknown): ApiDecimal {
  if (value instanceof ApiDecimal) return value;
  if (typeof value === "number" && Number.isFinite(value)) return ApiDecimal.parse(String(value));
  throw new RangeError("invalid-api-level");
}
