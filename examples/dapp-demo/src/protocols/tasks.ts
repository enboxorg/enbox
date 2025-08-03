export const taskDefinition = {
  published: true,
  protocol: "http://schema.org/protocols/TaskSample",
  types: {
    task: {
      dataFormats: ["application/json"],
      schema: "https://schema.org/TaskSample/schemas/task",
    }
  },
  structure: {
    task: {
      $tags: {
        $requiredTags: ["completed"],
        completed: {
          type: "boolean"
        }
      }
    }
  }
}