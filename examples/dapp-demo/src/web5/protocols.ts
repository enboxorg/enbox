import { profileDefinition } from "@/protocols/profile";
import { taskDefinition } from "@/protocols/tasks";
import { DwnApi } from "@enbox/api";

/**
 * Canonicalizes a given object according to RFC 8785 (https://tools.ietf.org/html/rfc8785),
 * which describes JSON Canonicalization Scheme (JCS). This function sorts the keys of the
 * object and its nested objects alphabetically and then returns a stringified version of it.
 * This method handles nested objects, array values, and null values appropriately.
 *
 * @param obj - The object to canonicalize.
 * @returns The stringified version of the input object with its keys sorted alphabetically
 * per RFC 8785.
 */
export function canonicalize(obj: { [key: string]: any }): string {
  /**
   * Recursively sorts the keys of an object.
   *
   * @param obj - The object whose keys are to be sorted.
   * @returns A new object with sorted keys.
   */
  const sortObjKeys = (obj: { [key: string]: any }): { [key: string]: any } => {
    if (obj !== null && typeof obj === 'object' && !Array.isArray(obj)) {
      const sortedKeys = Object.keys(obj).sort();
      const sortedObj: { [key: string]: any } = {};
      for (const key of sortedKeys) {
        // Recursively sort keys of nested objects.
        sortedObj[key] = sortObjKeys(obj[key]);
      }
      return sortedObj;
    }
    return obj;
  };

  // Stringify and return the final sorted object.
  const sortedObj = sortObjKeys(obj);
  return JSON.stringify(sortedObj);
}

const protocols = [ profileDefinition, taskDefinition ];

export const installProtocols = async (dwn: DwnApi, did: string) => {
  const installed = await dwn.protocols.query({ message: {} });
  const configurationPromises = [];
  try {
    for (const definition of protocols) {
      const record = installed.protocols.find(
        (record) => definition.protocol === record.definition.protocol
      );

      if (!record) {
        console.info("installing protocol: " + definition.protocol);
        configurationPromises.push(
          dwn.protocols.configure({
            message: { definition },
          })
        );
      } else if (canonicalize(record.definition) !== canonicalize(definition)) {
        console.info("updating protocol: " + definition.protocol);
        configurationPromises.push(dwn.protocols.configure({
          message: { definition }
        }))
      } else {
        console.info("protocol already installed: " + definition.protocol);
      }
    }

    const configurationResponses = await Promise.all(configurationPromises);
    try {
      await Promise.all(
        configurationResponses.map(({ protocol }) => protocol?.send(did))
      );
    } catch (e) {
      console.log("remote push of configuration failed", e);
      return true;
    }
  } catch (e) {
    console.log("local install of configuration failed", e);
    return false;
  }
  return true;
};
