import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CoverageBanner from '../CoverageBanner';

// The banner only renders what GET /api/metrics/coverage decides, so the API
// and the session are faked; the rules under test are what it shows to whom.
const apiFetch = vi.fn();
let role = 'admin';
vi.mock('../../hooks/useApi', () => ({ useApi: () => ({ apiFetch }) }));
vi.mock('../../auth/AuthProvider', () => ({ useAuth: () => ({ user: { role } }) }));

const RANGE = { range: 'custom', start: '2025-01-01T00:00:00.000Z', end: '2025-01-31T23:59:59.999Z' };

function respond(body) {
  apiFetch.mockResolvedValue({ ok: true, json: async () => body });
}

function renderBanner() {
  return render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><CoverageBanner rangeParams={RANGE} /></MemoryRouter>);
}

const NEEDS_SYNC = {
  needs_attention: true,
  before_first_data: true,
  first_data_at: '2025-01-15T00:00:00.000Z',
  beyond_retention: false,
  can_sync: true,
  suggested_sync: { start: '2025-01-01', end: '2025-01-14' },
};

beforeEach(() => {
  apiFetch.mockReset();
  role = 'admin';
});

describe('CoverageBanner', () => {
  it('renders nothing when the range is fully covered', async () => {
    respond({ needs_attention: false });
    const { container } = renderBanner();
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('asks for the coverage of the exact range it was given', async () => {
    respond({ needs_attention: false });
    renderBanner();
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalled());
    const url = new URL(apiFetch.mock.calls[0][0], 'http://x');
    expect(url.pathname).toBe('/api/metrics/coverage');
    expect(Object.fromEntries(url.searchParams)).toEqual(RANGE);
  });

  it('gives admins a link to Sync with the missing span pre-filled', async () => {
    respond(NEEDS_SYNC);
    renderBanner();
    const link = await screen.findByRole('link', { name: 'Importar este historial' });
    expect(link).toHaveAttribute('href', '/sync?start=2025-01-01&end=2025-01-14');
    expect(screen.getByRole('status')).toHaveTextContent('Los registros empiezan el');
  });

  it('tells members to ask an admin instead of linking to Sync', async () => {
    role = 'member';
    respond(NEEDS_SYNC);
    renderBanner();
    expect(await screen.findByText(/Pide a un admin/)).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
