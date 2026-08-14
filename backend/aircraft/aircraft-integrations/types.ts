export type AircraftIntegrationPrimitive = string | number | boolean;

export type AircraftIntegrationDecoder = Readonly<
  | {
    type: 'number';
    offset?: number;
    precision?: number;
    scale?: number;
    /** Exact raw numeric values published by the aircraft as unavailable sentinels. */
    unavailableValues?: readonly number[];
  }
  | {
    type: 'boolean';
    falseValues: readonly AircraftIntegrationPrimitive[];
    trueValues: readonly AircraftIntegrationPrimitive[];
  }
  | {
    type: 'enum';
    values: Readonly<Record<string, AircraftIntegrationPrimitive>>;
  }
>;

export type AircraftIntegrationReadRoute = Readonly<
  | {
    type: 'lvar';
    name: string;
    unit: string;
  }
  | {
    type: 'simvar';
    name: string;
    unit: string;
  }
  | {
    type: 'input-event';
    name: string;
  }
  | {
    type: 'sdk';
    adapter: string;
    path: string;
  }
>;

export type AircraftIntegrationFieldSource = Readonly<{
  decode: AircraftIntegrationDecoder;
  route: AircraftIntegrationReadRoute;
}>;

export type AircraftIntegrationField = Readonly<{
  id: string;
  /** Ordered candidates; the loader compiles the first supported binding. */
  sources: readonly AircraftIntegrationFieldSource[];
}>;

export type AircraftIntegrationReadback = Readonly<{
  /** Stable, transport-independent field used for confirmation. */
  fieldId: string;
  timeoutMs: number;
} & (
  | {
    expectedValue: AircraftIntegrationPrimitive;
  }
  | {
    /** Confirm against the adapter-validated logical number supplied by the client. */
    expectedInput: true;
  }
  | {
    /** Confirm a momentary/rotary control by requiring a newer, different value. */
    confirmation: 'changed';
  }
)>;

export type AircraftIntegrationNumberInput = Readonly<{
  max: number;
  min: number;
  step: number;
  type: 'number';
}>;

export type AircraftIntegrationInputValue = Readonly<{
  offset?: number;
  round?: 'nearest';
  scale?: number;
  source: 'input';
}>;

export type AircraftIntegrationSdkInputValue = AircraftIntegrationInputValue;

type MobiFlightCalculatorActionRouteBase = Readonly<{
  id: string;
  readback: AircraftIntegrationReadback;
  transport: 'mobiflight-calculator';
}>;

export type AircraftIntegrationActionPrecondition = Readonly<{
  expectedValue: AircraftIntegrationPrimitive;
  fieldId: string;
}>;

export type MobiFlightCalculatorActionRoute =
  | (MobiFlightCalculatorActionRouteBase & Readonly<{
    /** One fixed, adapter-owned calculator expression. */
    code: string;
    mode?: 'single';
  }>)
  | (MobiFlightCalculatorActionRouteBase & Readonly<{
    /** Physical-button press/release expressions executed once, in order. */
    delayMs: number;
    mode: 'pulse';
    pressCode: string;
    releaseCode: string;
  }>)
  | (MobiFlightCalculatorActionRouteBase & Readonly<{
    /** Readback-paced trusted increments/decrements toward a bounded numeric target. */
    circular?: true;
    decreaseCode: string;
    increaseCode: string;
    maxSteps: number;
    mode: 'step-to-target';
    precondition?: AircraftIntegrationActionPrecondition;
  }>);

export type InputEventActionRoute = Readonly<{
  id: string;
  inputEvent: string;
  readback?: AircraftIntegrationReadback;
  transport: 'input-event';
  value?: AircraftIntegrationPrimitive;
}>;

export type LvarActionRoute = Readonly<{
  id: string;
  lvar: string;
  readback: AircraftIntegrationReadback;
  transport: 'lvar';
  unit: string;
  value: boolean | number;
}>;

export type SimConnectSequenceOperation = Readonly<
  | {
    inputValue?: AircraftIntegrationInputValue;
    name: string;
    /** Fixed secondary SimConnect event parameters after the primary value. */
    parameters?: readonly number[];
    type: 'event';
    value?: number;
  }
  | {
    name: string;
    type: 'lvar';
    unit: string;
    value: boolean | number;
  }
  | {
    milliseconds: number;
    type: 'delay';
  }
  | {
    name: string;
    type: 'simvar';
    unit: string;
    value: boolean | number;
  }
>;

type SimConnectSequenceActionRouteBase = Readonly<{
  id: string;
  operations: readonly SimConnectSequenceOperation[];
  transport: 'simconnect-sequence';
}>;

export type SimConnectSequenceActionRoute = SimConnectSequenceActionRouteBase & Readonly<
  | {
    /** The sidecar accepted every fixed operation; cockpit state is not inferred. */
    confirmation: 'transport-acknowledged';
    readback?: never;
  }
  | {
    confirmation?: never;
    readback: AircraftIntegrationReadback;
  }
>;

export type SdkActionRoute = Readonly<{
  adapter: string;
  command: string;
  id: string;
  inputValue?: AircraftIntegrationSdkInputValue;
  readback?: AircraftIntegrationReadback;
  transport: 'sdk';
  value?: AircraftIntegrationPrimitive;
  /** Same trusted SDK event sent in order, for momentary press/release controls. */
  values?: readonly AircraftIntegrationPrimitive[];
}>;

export type AircraftIntegrationActionRoute =
  | MobiFlightCalculatorActionRoute
  | InputEventActionRoute
  | LvarActionRoute
  | SimConnectSequenceActionRoute
  | SdkActionRoute;

export type AircraftIntegrationTransport = AircraftIntegrationActionRoute['transport'];

/** Opaque selection safe to pass between backend orchestration layers. */
export type AircraftIntegrationRouteSelection = Readonly<{
  actionId: string;
  adapterId: string;
  routeId: string;
  transport: AircraftIntegrationTransport;
}>;

export type AircraftIntegrationAction = Readonly<{
  guard: Readonly<{
    cooldownMs: number;
    groupId: string;
    retry: 'never';
    /**
     * False when the confirmation field alone cannot prove the full requested
     * selector state (for example, strobe output while AUTO is selected).
     */
    skipIfSatisfied?: boolean;
  }>;
  id: string;
  input?: AircraftIntegrationNumberInput;
  /** Ordered by preference; runtime support determines the selected route. */
  routes: readonly AircraftIntegrationActionRoute[];
  verification: 'untested' | 'partial' | 'verified';
}>;

export type AircraftIntegrationDefinition = Readonly<{
  actions: Readonly<Record<string, AircraftIntegrationAction>>;
  aircraft: Readonly<{
    family: string;
    vendor: string;
  }>;
  fields: Readonly<Record<string, AircraftIntegrationField>>;
  id: string;
  presentation: Readonly<{
    templateId: string;
  }>;
  /** Exact profile keys allowed to activate this trusted executable mapping. */
  trustedProfileKeys: readonly string[];
}>;

export type ResolveAircraftIntegrationContext = Readonly<{
  profileKey?: unknown;
}>;

export type ResolveAircraftIntegrationActionContext = Readonly<{
  actionId?: unknown;
  adapterId?: unknown;
  profileKey?: unknown;
}>;

export type ResolveAircraftIntegrationFieldContext = Readonly<{
  adapterId?: unknown;
  fieldId?: unknown;
  profileKey?: unknown;
}>;

export type ResolveAircraftIntegrationRouteContext = ResolveAircraftIntegrationActionContext & Readonly<{
  routeId?: unknown;
}>;
