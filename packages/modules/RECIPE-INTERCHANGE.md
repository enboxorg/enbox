# Recipe JSON-LD interchange

`@enbox/modules/recipe-interchange` accepts a parsed Schema.org Recipe node and
returns a validated payload for `RecipesModule.records.create('recipe', …)`.
A browser importer can select a Recipe from a page's JSON-LD before invoking
this adapter. Select a matching existing recipe by its source URL and owner
before creating a duplicate. Confirm the destination when URLs are absent or
several records match.

```ts
import { exportRecipeJsonLd, importRecipeJsonLd } from '@enbox/modules/recipe-interchange';

const { data: recipe, omitted: unmappedSourceFields } = await importRecipeJsonLd(parsedNode);
const { data: jsonLd, omitted: privateOrUnmappedFields } = await exportRecipeJsonLd(recipe);
```

| Schema.org field or form | DWN recipe value |
| --- | --- |
| name, description, url, recipeCuisine | name, description, originalUrl, cuisine |
| recipeIngredient text | A verbatim ingredient line with fractions, ranges and preparation preserved in `text` |
| recipeIngredient PropertyValue | Structured ingredient name, optional decimal value with unitText, optional preparation in description |
| recipeInstructions text or ordered HowToStep entries | Ordered steps with instruction text |
| recipeYield text | An explicit numeric count in “2 servings” maps to servings. Other text, including “2 loaves”, remains in yieldText |
| prepTime, cookTime | Whole ISO 8601 hours and minutes converted to integer minutes |

The supported input has a simple HTTP(S) Schema.org context and one Recipe type.
The importer reads supplied JSON locally. Unsupported representations of mapped
fields raise an error, including ingredient amounts without units, unit codes,
HowToSection trees, and durations with seconds. It preserves a textual source
ingredient intact when the publisher supplied text. The public export uses
HowToStep records and minute durations. Keep the original JSON-LD when exact
publisher representation matters.

Both conversion functions return JSON Pointers for omitted fields, so callers
can show what the profile preserves before saving or exporting. Private notes,
record links, source metadata, local labels and per-step timers have no mapping
in this profile. Whole-text instructions remain one step. An array stays ordered.

The property names and representations follow [Schema.org Recipe](https://schema.org/Recipe),
[recipeIngredient](https://schema.org/recipeIngredient), [recipeInstructions](https://schema.org/recipeInstructions),
and [recipeYield](https://schema.org/recipeYield).
