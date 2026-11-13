import type {DeliveryRecord} from '../../shared/delivery';

/** Merge immutable export history so a delayed read cannot hide a completed creation.
 * @param current - Records already visible, including local POST completions.
 * @param incoming - Newly read or created immutable records.
 * @returns Unique records, newest first.
 */
export function mergeDeliveries(current:DeliveryRecord[],incoming:DeliveryRecord[]):DeliveryRecord[]{
  return [...new Map([...current,...incoming].map(row=>[row.id,row])).values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
}
