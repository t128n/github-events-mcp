import { invalidParams } from "./types.ts";
import type { JsonSchema } from "./types.ts";

const types = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);

/**
 * A deliberately small JSON Schema check: the subset an event `inputSchema` needs to reject a
 * bad subscription before it reaches an upstream. Unknown keywords are ignored, not rejected.
 */
export function validateArguments(schema: JsonSchema | undefined, value: unknown, path = "arguments"): Record<string, unknown> {
  if (value === undefined || value === null) value = {};
  if (!isObject(value)) throw invalidParams(`${path} must be an object`);
  if (!schema) return value;

  const type = schema.type;
  if (typeof type === "string" && types.has(type) && !matchesType(type, value)) {
    throw invalidParams(`${path} must be ${type}`);
  }

  const properties = isObject(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required.filter((x): x is string => typeof x === "string") : [];
  for (const key of required) {
    if (value[key] === undefined) throw invalidParams(`${path}.${key} is required`);
  }

  for (const [key, property] of Object.entries(properties)) {
    if (value[key] === undefined || !isObject(property)) continue;
    const p = property;
    const t = p.type;
    if (typeof t === "string" && types.has(t) && !matchesType(t, value[key])) {
      throw invalidParams(`${path}.${key} must be ${t}`);
    }
    if (Array.isArray(p.enum) && !p.enum.some((allowed) => allowed === value[key])) {
      throw invalidParams(`${path}.${key} is not one of the allowed values`);
    }
    if (Array.isArray(value[key])) {
      const items = p.items;
      if (isObject(items) && typeof items.type === "string") {
        value[key].forEach((item, index) => {
          if (!matchesType(items.type as string, item)) {
            throw invalidParams(`${path}.${key}[${index}] must be ${items.type}`);
          }
        });
      }
      if (typeof p.maxItems === "number" && value[key].length > p.maxItems) {
        throw invalidParams(`${path}.${key} has more than ${p.maxItems} items`);
      }
    }
    if (typeof p.maxLength === "number" && typeof value[key] === "string" && value[key].length > p.maxLength) {
      throw invalidParams(`${path}.${key} is longer than ${p.maxLength}`);
    }
  }
  return value;
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "object":
      return isObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true;
  }
}

export const isObject = (value: unknown): value is Record<string, any> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
