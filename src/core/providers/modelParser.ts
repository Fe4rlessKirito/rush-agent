const MODEL_COLLECTION_KEYS = [
  "data",
  "models",
  "modelGroups",
  "model_groups",
  "groups",
  "groupedModels",
  "grouped_models",
  "availableModels",
  "available_models",
];

const MODEL_ID_KEYS = ["id", "model", "name"];
const NON_MODEL_MAP_KEYS = new Set([
  "created",
  "data",
  "description",
  "groups",
  "metadata",
  "modelGroups",
  "model_groups",
  "models",
  "object",
  "owned_by",
  "ownedBy",
  "permission",
  "permissions",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasCollection(value: Record<string, unknown>): boolean {
  return MODEL_COLLECTION_KEYS.some((key) => key in value);
}

function hasModelId(value: Record<string, unknown>): boolean {
  return MODEL_ID_KEYS.some((key) => typeof value[key] === "string");
}

function addModel(models: Set<string>, value: unknown) {
  if (typeof value !== "string") return;
  const model = value.trim();
  if (model) models.add(model);
}

function collectModels(value: unknown, models: Set<string>, inModelCollection = false) {
  if (typeof value === "string") {
    if (inModelCollection) addModel(models, value);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectModels(item, models, true);
    return;
  }

  if (!isRecord(value)) return;

  let foundCollection = false;
  for (const key of MODEL_COLLECTION_KEYS) {
    if (key in value) {
      foundCollection = true;
      collectModels(value[key], models, true);
    }
  }

  if (foundCollection) return;

  for (const key of MODEL_ID_KEYS) {
    if (typeof value[key] === "string") {
      addModel(models, value[key]);
      return;
    }
  }

  if (!inModelCollection) return;

  for (const [key, child] of Object.entries(value)) {
    if (NON_MODEL_MAP_KEYS.has(key)) continue;
    if (isRecord(child)) {
      if (!hasCollection(child) && !hasModelId(child)) models.add(key);
      collectModels(child, models, true);
    } else if (Array.isArray(child)) {
      collectModels(child, models, true);
    } else if (typeof child === "string") {
      addModel(models, child);
    }
  }
}

export function parseModelList(payload: unknown, fallbackModel?: string): string[] {
  const models = new Set<string>();
  collectModels(payload, models);
  addModel(models, fallbackModel);
  return [...models];
}
