import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createAppServer } from '../src/server.js';

async function setup(t) {
  const server = await createAppServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return (path, options) => fetch(`${base}${path}`, options);
}

const booking = {
  roomId: 'cedar', title: 'Design review', organizer: 'Sam Rivera',
  startTime: '2030-06-12T09:00:00Z', endTime: '2030-06-12T10:00:00Z',
};
const post = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('API lists rooms, creates a booking, and retrieves it', async (t) => {
  const request = await setup(t);
  const rooms = await request('/api/rooms');
  assert.equal(rooms.status, 200);
  assert.match(rooms.headers.get('content-type'), /application\/json/);
  assert.equal((await rooms.json()).length, 3);
  const created = await request('/api/bookings', post(booking));
  assert.equal(created.status, 201);
  const result = await created.json();
  assert.equal(result.title, booking.title);
  const listed = await request('/api/bookings?roomId=cedar&date=2030-06-12');
  assert.equal(listed.status, 200);
  assert.deepEqual(await listed.json(), [result]);
});

test('API returns 409 with a conflict message when a booking overlaps an existing booking in the same room', async (t) => {
  const request = await setup(t);
  const first = await request('/api/bookings', post(booking));
  assert.equal(first.status, 201);
  const conflicting = await request('/api/bookings', post({
    ...booking, startTime: '2030-06-12T09:30:00Z', endTime: '2030-06-12T09:45:00Z',
  }));
  assert.equal(conflicting.status, 409);
  assert.deepEqual(await conflicting.json(), { error: 'This room is already booked from 09:00 to 10:00 UTC.' });
  const listed = await request('/api/bookings?roomId=cedar&date=2030-06-12');
  assert.equal((await listed.json()).length, 1);
});

test('API allows a booking that starts exactly when another ends in the same room', async (t) => {
  const request = await setup(t);
  await request('/api/bookings', post(booking));
  const backToBack = await request('/api/bookings', post({
    ...booking, startTime: booking.endTime, endTime: '2030-06-12T11:00:00Z',
  }));
  assert.equal(backToBack.status, 201);
});

test('API allows overlapping bookings in different rooms', async (t) => {
  const request = await setup(t);
  const first = await request('/api/bookings', post(booking));
  assert.equal(first.status, 201);
  const second = await request('/api/bookings', post({ ...booking, roomId: 'maple' }));
  assert.equal(second.status, 201);
});

test('API returns useful validation errors and does not create invalid bookings', async (t) => {
  const request = await setup(t);
  const response = await request('/api/bookings', post({ ...booking, endTime: booking.startTime }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'End time must be after start time.' });
  const listed = await request('/api/bookings?roomId=cedar&date=2030-06-12');
  assert.deepEqual(await listed.json(), []);
});

test('API requires valid room and date filters', async (t) => {
  const request = await setup(t);
  for (const query of ['', '?roomId=missing&date=2030-06-12', '?roomId=cedar&date=2030-02-30']) {
    const response = await request(`/api/bookings${query}`);
    assert.equal(response.status, 400);
    assert.equal(typeof (await response.json()).error, 'string');
  }
});

test('malformed JSON returns 400', async (t) => {
  const request = await setup(t);
  const response = await request('/api/bookings', { ...post(booking), body: '{"title":' });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /valid JSON/);
});

test('wrong content type returns 415', async (t) => {
  const request = await setup(t);
  const response = await request('/api/bookings', { method: 'POST', body: '{}' });
  assert.equal(response.status, 415);
});

test('large requests return 413', async (t) => {
  const request = await setup(t);
  const response = await request('/api/bookings', post({ ...booking, title: 'x'.repeat(20_000) }));
  assert.equal(response.status, 413);
});

test('unknown endpoints return JSON 404 and unsupported methods return 405', async (t) => {
  const request = await setup(t);
  assert.equal((await request('/api/missing')).status, 404);
  const response = await request('/api/bookings', { method: 'DELETE' });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET, POST');
});

test('static requests cannot expose application source outside dist', async (t) => {
  const request = await setup(t);
  for (const path of ['/src/server.js', '/..%2fsrc%2fserver.js', '/package.json']) {
    assert.equal((await request(path)).status, 404);
  }
});

test('new server instances do not inherit previous bookings', async (t) => {
  const first = await setup(t);
  await first('/api/bookings', post(booking));
  const second = await setup(t);
  assert.deepEqual(await (await second('/api/bookings?roomId=cedar&date=2030-06-12')).json(), []);
});

test('backend serves no frontend HTML', async (t) => {
  const request = await setup(t);
  const response = await request('/');
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'API endpoint not found.' });
});

test('parser errors preserve the JSON error contract', async (t) => {
  const request = await setup(t);
  const malformed = await request('/api/bookings', { ...post(booking), body: '{' });
  assert.deepEqual(await malformed.json(), { error: 'Request body must be valid JSON.' });
  const oversized = await request('/api/bookings', post({ ...booking, title: 'x'.repeat(20_000) }));
  assert.deepEqual(await oversized.json(), { error: 'Request body is too large.' });
});

test('routes remain case-sensitive, exact, and limited to their supported methods', async (t) => {
  const request = await setup(t);
  assert.equal((await request('/api/Rooms')).status, 404);
  assert.equal((await request('/api/rooms/')).status, 404);
  const response = await request('/api/rooms', { method: 'HEAD' });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET');
});
