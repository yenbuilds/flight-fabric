import type { AircraftIntegrationDefinition } from '../integration-engine/types.js';
import { bundledProfileKeySchema, createDocumentValidator, strictObject } from '../integration-engine/definition-yaml.js';

type LegacyExport = Readonly<
  | { kind: 'integration' | 'id'; order: number }
  | { kind: 'profile'; profileKey: string; order: number }
>;
export type IntegrationCatalogue = Readonly<{
  order: number;
  legacyExports: Readonly<Record<string, LegacyExport>>;
}>;

const order = { type: 'integer', minimum: 0, maximum: 4095 };
export const catalogueSchema = strictObject({
  order,
  legacyExports: {
    type: 'object', maxProperties: 128,
    propertyNames: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,127}(?![\\s\\S])' },
    additionalProperties: { oneOf: [
      strictObject({ kind: { enum: ['integration', 'id'] }, order }),
      strictObject({ kind: { const: 'profile' }, profileKey: bundledProfileKeySchema, order }),
    ] },
  },
});
const validate = createDocumentValidator<IntegrationCatalogue>(catalogueSchema);

/** Optional on custom definitions; bundled catalogue entries opt in explicitly. */
export function assertIntegrationCatalogue(definition: AircraftIntegrationDefinition): void {
  const catalogue = definition.catalogue;
  if (catalogue === undefined) return;
  if (!validate(catalogue) || Object.values(catalogue.legacyExports).some(entry =>
    entry.kind === 'profile' && !definition.trustedProfileKeys.includes(entry.profileKey))) {
    throw new TypeError(`Invalid integration catalogue for "${definition.id}".`);
  }
  const orders = Object.values(catalogue.legacyExports).map(entry => entry.order);
  if (new Set(orders).size !== orders.length) throw new TypeError(`Duplicate legacy export order for "${definition.id}".`);
}

/** Resolve compatibility aliases from data without deriving aircraft identities from export names. */
export function buildIntegrationCatalogue(input: readonly AircraftIntegrationDefinition[]) {
  const definitionOrders = new Set<number>();
  const exportNames = new Set<string>();
  const exportOrders = new Set<number>();
  const exports: { name: string; order: number; value: unknown }[] = [];
  for (const definition of input) {
    assertIntegrationCatalogue(definition);
    const catalogue = definition.catalogue;
    if (!catalogue) throw new TypeError(`Missing integration catalogue for "${definition.id}".`);
    if (definitionOrders.has(catalogue.order)) throw new TypeError('Duplicate integration catalogue order.');
    definitionOrders.add(catalogue.order);
    for (const [name, entry] of Object.entries(catalogue.legacyExports)) {
      if (exportNames.has(name) || exportOrders.has(entry.order)) throw new TypeError('Duplicate integration catalogue export.');
      exportNames.add(name);
      exportOrders.add(entry.order);
      exports.push({ name, order: entry.order, value: entry.kind === 'integration' ? definition
        : entry.kind === 'profile' ? entry.profileKey : definition.id });
    }
  }
  return {
    definitions: [...input].sort((left, right) => left.catalogue.order - right.catalogue.order),
    legacyExports: exports.sort((left, right) => left.order - right.order).map(({ name, value }) => [name, value] as const),
  };
}
