/** Existing read contracts; source selection and decoding stay in the shared runtime. */
export declare const fieldDefinitionSchema: {
    type: string;
    additionalProperties: boolean;
    required: string[];
    properties: Record<string, import("ajv").AnySchema>;
};
