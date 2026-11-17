import type { RecipeData } from './recipes.js';

import { RecipesCodecs } from './recipes.js';

/** One compact Schema.org Recipe node. Callers select the node before importing a graph. */
export type SchemaOrgRecipe = {
  '@context': 'https://schema.org';
  '@type': 'Recipe';
  name: string;
  recipeIngredient: (string | { '@type': 'PropertyValue'; name: string; value?: string; unitText?: string; description?: string })[];
  recipeInstructions: { '@type': 'HowToStep'; text: string }[];
  description?: string;
  recipeCuisine?: string;
  recipeYield?: string;
  prepTime?: string;
  cookTime?: string;
  url?: string;
};

/** JSON Pointers identify source fields omitted by this conversion. */
export type RecipeConversion<T> = { data: T; omitted: string[] };

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`Expected an object at ${path}.`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`Expected text at ${path}.`);
  }
  return value;
}

function hasType(node: Record<string, unknown>, type: string): boolean {
  return node['@type'] === type || node['@type'] === `https://schema.org/${type}`;
}

function omittedKeys(node: object, keys: readonly string[], base = ''): string[] {
  return Object.keys(node)
    .filter((key) => !keys.includes(key))
    .map((key) => `${base}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`);
}

function list<T>(value: unknown, path: string, convert: (item: unknown, path: string) => T): [T, ...T[]] {
  if (!Array.isArray(value)) {
    return [convert(value, path)];
  }
  if (value.length === 0 || value.length > 500) {
    throw new TypeError(`Expected 1–500 entries at ${path}.`);
  }
  return [convert(value[0], `${path}/0`), ...value.slice(1).map((item, i) => convert(item, `${path}/${i + 1}`))];
}

function minutes(value: unknown, path: string): number {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?$/.exec(text(value, path));
  if (!match || (match[1] === undefined && match[2] === undefined)) {
    throw new TypeError(`Expected an ISO duration in whole hours or minutes at ${path}.`);
  }
  return Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0);
}

function readIngredient(value: unknown, path: string, omitted: string[]): RecipeData['ingredients'][number] {
  if (typeof value === 'string') {
    return { text: text(value, path) };
  }
  const item = object(value, path);
  if (!hasType(item, 'PropertyValue') || item['@context'] !== undefined || item.unitCode !== undefined) {
    throw new TypeError(`Expected ingredient text or a PropertyValue with a quantity in unitText at ${path}.`);
  }
  omitted.push(...omittedKeys(item, ['@type', 'name', 'value', 'unitText', 'description'], path));
  const ingredient = {
    name: text(item.name, `${path}/name`),
    ...(item.description === undefined ? {} : { preparation: text(item.description, `${path}/description`) }),
  };
  if (item.value === undefined && item.unitText === undefined) {
    return ingredient;
  }
  const amount = typeof item.value === 'number' ? String(item.value) : text(item.value, `${path}/value`);
  return { ...ingredient, quantity: { value: amount, unit: text(item.unitText, `${path}/unitText`) } };
}

/** Import supported compact Recipe JSON-LD without interpreting ingredient prose or fetching linked documents. */
export async function importRecipeJsonLd(input: unknown): Promise<RecipeConversion<RecipeData>> {
  const node = object(input, '/');
  if (
    typeof node['@context'] !== 'string' ||
    !['https://schema.org', 'https://schema.org/', 'http://schema.org', 'http://schema.org/'].includes(node['@context']) ||
    !hasType(node, 'Recipe')
  ) {
    throw new TypeError('Expected a compact Schema.org Recipe node with a Schema.org context.');
  }
  const omitted = omittedKeys(node, [
    '@context',
    '@type',
    'name',
    'description',
    'recipeIngredient',
    'recipeInstructions',
    'recipeCuisine',
    'recipeYield',
    'prepTime',
    'cookTime',
    'url',
  ]);
  const ingredients = list(node.recipeIngredient, '/recipeIngredient', (value, path) => readIngredient(value, path, omitted));
  const steps = list(node.recipeInstructions, '/recipeInstructions', (value, path) => {
    if (typeof value === 'string') {
      return { instruction: text(value, path) };
    }
    const item = object(value, path);
    if (!hasType(item, 'HowToStep') || item['@context'] !== undefined) {
      throw new TypeError(`Expected text or a HowToStep at ${path}.`);
    }
    omitted.push(...omittedKeys(item, ['@type', 'text'], path));
    return { instruction: text(item.text, `${path}/text`) };
  });
  const data: RecipeData = { name: text(node.name, '/name'), ingredients, steps };
  if (node.description !== undefined) {
    data.description = text(node.description, '/description');
  }
  if (node.recipeCuisine !== undefined) {
    data.cuisine = text(node.recipeCuisine, '/recipeCuisine');
  }
  if (node.url !== undefined) {
    data.originalUrl = text(node.url, '/url');
  }
  if (node.prepTime !== undefined) {
    data.prepMinutes = minutes(node.prepTime, '/prepTime');
  }
  if (node.cookTime !== undefined) {
    data.cookMinutes = minutes(node.cookTime, '/cookTime');
  }
  if (node.recipeYield !== undefined) {
    const yieldText = text(node.recipeYield, '/recipeYield');
    const servings = /^(\d+(?:\.\d+)?) servings?$/i.exec(yieldText);
    if (servings) {
      data.servings = Number(servings[1]);
    } else {
      data.yieldText = yieldText;
    }
  }
  await RecipesCodecs.recipe.encode(data);
  return { data, omitted };
}

/** Export interoperable recipe content and report local fields omitted from the interchange projection. */
export async function exportRecipeJsonLd(recipe: RecipeData): Promise<RecipeConversion<SchemaOrgRecipe>> {
  await RecipesCodecs.recipe.encode(recipe);
  const omitted = omittedKeys(recipe, [
    'name',
    'ingredients',
    'steps',
    'description',
    'cuisine',
    'servings',
    'yieldText',
    'prepMinutes',
    'cookMinutes',
    'originalUrl',
  ]);
  const data: SchemaOrgRecipe = {
    '@context'       : 'https://schema.org',
    '@type'          : 'Recipe',
    name             : recipe.name,
    recipeIngredient : recipe.ingredients.map((item, i) => {
      if (item.text !== undefined) {
        return item.text;
      }
      omitted.push(...omittedKeys(item, ['name', 'quantity', 'preparation'], `/ingredients/${i}`));
      return {
        '@type' : 'PropertyValue',
        name    : item.name!,
        ...(item.quantity === undefined ? {} : { value: item.quantity.value, unitText: item.quantity.unit }),
        ...(item.preparation === undefined ? {} : { description: item.preparation }),
      };
    }),
    recipeInstructions: recipe.steps.map((step, i) => {
      omitted.push(...omittedKeys(step, ['instruction'], `/steps/${i}`));
      return { '@type': 'HowToStep', text: step.instruction };
    }),
  };
  if (recipe.description !== undefined) {
    data.description = recipe.description;
  }
  if (recipe.cuisine !== undefined) {
    data.recipeCuisine = recipe.cuisine;
  }
  if (recipe.originalUrl !== undefined) {
    data.url = recipe.originalUrl;
  }
  if (recipe.prepMinutes !== undefined) {
    data.prepTime = `PT${recipe.prepMinutes}M`;
  }
  if (recipe.cookMinutes !== undefined) {
    data.cookTime = `PT${recipe.cookMinutes}M`;
  }
  if (recipe.servings !== undefined) {
    data.recipeYield = `${recipe.servings} ${recipe.servings === 1 ? 'serving' : 'servings'}`;
  }
  if (recipe.yieldText !== undefined) {
    data.recipeYield = recipe.yieldText;
  }
  return { data, omitted };
}
