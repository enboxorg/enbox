import type { RecipeData } from '../src/recipes.js';

import { describe, expect, it } from 'bun:test';
import { exportRecipeJsonLd, importRecipeJsonLd } from '../src/recipe-interchange.js';

const simple = {
  '@context'         : 'https://schema.org',
  '@type'            : 'Recipe',
  name               : 'Bean soup',
  recipeIngredient   : '½–1 can white beans, drained',
  recipeInstructions : 'Simmer gently.',
};

describe('Schema.org recipe interchange', () => {
  it('preserves a published ingredient line, instructions and non-serving yield without parsing their prose', async () => {
    const { data, omitted } = await importRecipeJsonLd({
      ...simple,
      recipeYield         : '2 jars',
      recipeCuisine       : 'Italian',
      url                 : 'https://example.com/soup',
      description         : 'A weekday dinner.',
      prepTime            : 'PT1H5M',
      cookTime            : 'PT30M',
      nutrition           : { '@type': 'NutritionInformation' },
      'custom/field~name' : true,
    });
    expect(data).toEqual({
      name        : 'Bean soup',
      ingredients : [{ text: simple.recipeIngredient }],
      steps       : [{ instruction: simple.recipeInstructions }],
      yieldText   : '2 jars',
      cuisine     : 'Italian',
      originalUrl : 'https://example.com/soup',
      description : 'A weekday dinner.',
      prepMinutes : 65,
      cookMinutes : 30,
    });
    expect(omitted).toEqual(['/nutrition', '/custom~1field~0name']);
    const exported = await exportRecipeJsonLd(data);
    expect(exported.omitted).toEqual([]);
    expect(exported.data.recipeIngredient).toEqual([simple.recipeIngredient]);
    expect(exported.data.prepTime).toBe('PT65M');
    expect((await importRecipeJsonLd(exported.data)).data).toEqual(data);
  });

  it('round-trips structured quantities, preparation, named ingredients, step order, and explicit serving counts', async () => {
    const original: RecipeData = {
      name        : 'Porridge',
      servings    : 2,
      ingredients : [{ name: 'Oats', quantity: { value: '0.50', unit: 'cup' }, preparation: 'soaked overnight' }, { name: 'Water' }],
      steps       : [{ instruction: 'Combine.' }, { instruction: 'Cook.' }],
    };
    const exported = await exportRecipeJsonLd(original);
    expect(exported.omitted).toEqual([]);
    expect(exported.data.recipeYield).toBe('2 servings');
    expect(exported.data.recipeIngredient[0]).toEqual({
      '@type'     : 'PropertyValue',
      name        : 'Oats',
      value       : '0.50',
      unitText    : 'cup',
      description : 'soaked overnight',
    });
    expect((await importRecipeJsonLd(exported.data)).data).toEqual(original);
    expect((await exportRecipeJsonLd({ ...original, servings: 1 })).data.recipeYield).toBe('1 serving');
    const parsed = await importRecipeJsonLd({
      ...simple,
      recipeIngredient: [{ '@type': 'PropertyValue', name: 'Salt', value: 1, unitText: 'pinch' }],
    });
    expect(parsed.data.ingredients[0]).toEqual({ name: 'Salt', quantity: { value: '1', unit: 'pinch' } });
  });

  it('reports omitted private and form-specific fields without copying their values into the export', async () => {
    const recipe: RecipeData = {
      name        : 'Tea',
      ingredients : [{ name: 'Lemon', optional: true }],
      steps       : [{ instruction: 'Steep.', minutes: 4 }],
      notes       : 'Private family note',
      labels      : ['personal'],
    };
    const { data, omitted } = await exportRecipeJsonLd(recipe);
    expect(omitted).toEqual(['/notes', '/labels', '/ingredients/0/optional', '/steps/0/minutes']);
    expect(JSON.stringify(data)).not.toContain('Private family note');
    const converted = await importRecipeJsonLd({
      ...simple,
      recipeIngredient   : { '@type': 'PropertyValue', name: 'Peas', identifier: 'example' },
      recipeInstructions : [{ '@type': 'HowToStep', text: 'Serve.', image: 'https://example.com/dish.jpg' }],
    });
    expect(converted.omitted).toEqual(['/recipeIngredient/identifier', '/recipeInstructions/0/image']);
  });

  it('requires a complete supported recipe and rejects ambiguous or unrepresentable inputs', async () => {
    for (const value of [
      null,
      [],
      { ...simple, '@context': 'https://example.com/context' },
      { ...simple, '@type': 'Article' },
      { ...simple, recipeIngredient: [] },
      { ...simple, recipeIngredient: ' ' },
      { ...simple, recipeInstructions: { '@type': 'HowToSection' } },
      { ...simple, recipeIngredient: { '@type': 'PropertyValue', name: 'Rice', value: 2 } },
      { ...simple, recipeIngredient: { '@type': 'PropertyValue', name: 'Rice', value: '1/2', unitText: 'cup' } },
      { ...simple, recipeIngredient: { '@type': 'PropertyValue', name: 'Rice', value: 2, unitCode: 'G21' } },
      { ...simple, recipeInstructions: { '@type': 'HowToStep', text: 'Bake', '@context': {} } },
      { ...simple, cookTime: 'PT30S' },
      { ...simple, cookTime: 'PT' },
      { ...simple, recipeYield: { '@type': 'QuantitativeValue', value: 3 } },
      { ...simple, recipeYield: '99999 servings' },
    ]) {
      await expect(importRecipeJsonLd(value)).rejects.toThrow();
    }
  });
});
