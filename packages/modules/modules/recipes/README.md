# Recipes

Ingredients, quantities, servings, preparation steps, and personal variations.

Module URI: `https://enbox.id/modules/recipes/v1`

Import `RecipesModule`, `RecipesDefinition`, `RecipesCodecs`, and `RecipesSchemas` from `@enbox/modules/recipes`. `RecipesCatalog` includes the actual writable paths, bundled schemas, and examples.

## Artifacts

- [Raw definition](definition.json)
- [Directory metadata](catalog.json)
- [Complete record examples](examples.json)

| Path | Representation | Data policy | Record policy |
| --- | --- | --- | --- |
| `recipe` | [JSON Schema](schemas/recipe.json) | Encrypted | Mutable |
| `recipe/variation` | [JSON Schema](schemas/variation.json) | Encrypted | Mutable |
| `recipe/editor` | [JSON Schema](schemas/editor.json) | Plaintext | Membership |
| `recipe/viewer` | [JSON Schema](schemas/viewer.json) | Plaintext | Membership |

## Dependencies and ownership

This module has no structural module dependencies. Payload links retain their targets' ownership and permissions.

The definition's `published` flag describes definition discovery. Record access is governed by the definition's explicit actions. Roles are assigned by the owner; a role's recipient is in the signed DWN descriptor, and its data is `{}`. Without assigned roles or grants, private paths remain owner-only. Record-specific action lists remain authoritative.

## Actions

The owner retains tenant authority. These rules describe additional authority. `update`, `delete`, and `prune` act on the signer's own authored records; their `co-` variants allow acting on other authors' records. A `who: recipient` rule is scoped to that record's recipient: `co-delete` on a role assignment allows self-removal, never removal of another recipient. Self-removal uses the actor rule without invoking `moduleRole`. Viewers are read-only apart from leaving their own membership.

| Path | Additional authority |
| --- | --- |
| `recipe` | role recipe/editor: read, co-update<br>role recipe/viewer: read |
| `recipe/variation` | role recipe/editor: create, read, update, delete<br>role recipe/viewer: read |
| `recipe/editor` | recipient of recipe/editor: read<br>recipient of this record: co-delete |
| `recipe/viewer` | recipient of recipe/viewer: read<br>recipient of this record: co-delete |

Immutable records reject updates. A singleton uses `$recordLimit` projection semantics; it does not reject every competing create. Pruning follows actual descendants, including composed descendants; data links do not cascade.

## Use

Start with an authenticated Enbox session and include this module in the application's module manifest. Dependency artifacts are carried by the typed module and installed before consumers.

```ts
import { RecipesModule } from '@enbox/modules/recipes';

const records = enbox.using(RecipesModule).records;
await records.create('recipe', {
  data: {
  "name": "Lentil soup",
  "servings": 4,
  "ingredients": [
    {
      "name": "Lentils",
      "quantity": {
        "value": "200",
        "unit": "g"
      }
    }
  ],
  "steps": [
    {
      "instruction": "Simmer the lentils in water until tender.",
      "minutes": 25
    }
  ]
},
});
```

The JSON codecs validate on encode and decode. Examples are illustrative data; imported claims remain subject to their original provenance. See the [package guide](../../README.md) for shared reference, money, source, and access semantics.
