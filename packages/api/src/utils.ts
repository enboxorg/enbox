import { Convert, universalTypeOf } from '@enbox/common';

/**
 * Converts various data types to a `Blob` object, automatically detecting the data type or using
 * the specified `dataFormat` to set the Blob's MIME type.
 *
 * This function supports plain text, JSON objects, binary data (Uint8Array, ArrayBuffer), and Blob
 * inputs and will attempt to automatically detect the type of the data if `dataFormat` is not
 * explicitly provided.
 *
 * @beta
 *
 * @example
 * ```ts
 * // Convert a JSON object to a Blob
 * const { dataBlob, dataFormat } = dataToBlob({ key: 'value' }, 'application/json');
 *
 * // Convert a plain text string to a Blob without specifying dataFormat
 * const { dataBlob: textBlob } = dataToBlob('Hello, world!');
 *
 * // Convert binary data to a Blob
 * const binaryData = new Uint8Array([0, 1, 2, 3]);
 * const { dataBlob: binaryBlob } = dataToBlob(binaryData);
 * ```
 *
 * @param data - The data to be converted into a `Blob`. This can be a string, an object, binary
 *               data (Uint8Array or ArrayBuffer), or a Blob.
 * @param dataFormat - An optional MIME type string that specifies the format of the data. Common
 *                     types include 'text/plain' for string data, 'application/json' for JSON
 *                     objects, and 'application/octet-stream' for binary data. If not provided, the
 *                     function will attempt to detect the format based on the data type or default
 *                     to 'application/octet-stream'.
 * @returns An object containing the `dataBlob`, a Blob representation of the input data, and
 *          `dataFormat`, the MIME type of the data as determined by the function or specified by the caller.
 * @throws An error if the data type is not supported or cannot be converted to a Blob.
 */
export function dataToBlob(data: any, dataFormat?: string): {
  /** A Blob representation of the input data. */
  dataBlob: Blob;
  /** The MIME type of the data. */
  dataFormat: string;
} {
  let dataBlob: Blob;

  // Track the detected MIME type separately from the Blob's type property because Bun's Blob
  // constructor appends `;charset=utf-8` to text-based types (e.g. `text/plain` becomes
  // `text/plain;charset=utf-8`). The DWN protocol authorization performs exact string matching
  // on `dataFormat`, so we must use the canonical MIME type without parameters.
  let detectedMimeType: string | undefined;

  // Already encoded Blob and byte values always win over format-based legacy
  // conversion. This prevents an explicit JSON format from serializing their
  // container object instead of preserving their bytes.
  const detectedType = universalTypeOf(data);
  if (detectedType === 'Blob') {
    dataBlob = data;
  } else if (detectedType === 'Uint8Array' || detectedType === 'ArrayBuffer') {
    detectedMimeType = 'application/octet-stream';
    dataBlob = new Blob([data], { type: detectedMimeType });
  } else if (dataFormat === 'text/plain' || detectedType === 'String') {
    detectedMimeType = 'text/plain';
    dataBlob = new Blob([data], { type: detectedMimeType });
  } else if (dataFormat === 'application/json' || detectedType === 'Object') {
    detectedMimeType = 'application/json';
    const dataBytes = Convert.object(data).toUint8Array();
    dataBlob = new Blob([dataBytes as BlobPart], { type: detectedMimeType });
  } else {
    throw new Error('data type not supported.');
  }

  dataFormat = dataFormat || detectedMimeType || dataBlob.type || 'application/octet-stream';

  return { dataBlob, dataFormat };
}
