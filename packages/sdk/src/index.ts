/**
 * @setu/sdk — TypeScript client SDK for the Setu platform.
 *
 * Usage:
 *   import { SetuClient } from '@setu/sdk';
 *
 *   const setu = new SetuClient({
 *     url: 'https://api.setu.example.com',
 *     apiKey: 'sk_...',
 *   });
 *
 *   const patients = await setu
 *     .from('patients')
 *     .select('name, phone, diagnosis')
 *     .forPurpose('appointment_reminder');
 */

export { SetuClient } from './client.js';
export type { SetuClientConfig } from './client.js';
