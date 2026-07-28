import { useState, useEffect } from 'preact/hooks';
import { api } from '../lib/api';

type ConfigFields = {
  logLevel                       : string;
  maxInFlight                    : number;
  rateLimitRequestsPerSecond     : number;
  rateLimitBurst                 : number;
  rateLimitTenantRequestsPerSecond : number;
  rateLimitTenantBurst           : number;
};

const emptyConfig: ConfigFields = {
  logLevel                         : '',
  maxInFlight                      : 0,
  rateLimitRequestsPerSecond       : 0,
  rateLimitBurst                   : 0,
  rateLimitTenantRequestsPerSecond : 0,
  rateLimitTenantBurst             : 0,
};

type FieldDef = {
  key   : keyof ConfigFields;
  label : string;
  type  : 'text' | 'number';
};

type FieldGroup = {
  title  : string;
  fields : FieldDef[];
};

const fieldGroups: FieldGroup[] = [
  {
    title  : 'General',
    fields : [
      { key: 'logLevel',    label: 'Log Level',     type: 'text' },
      { key: 'maxInFlight', label: 'Max In-Flight', type: 'number' },
    ],
  },
  {
    title  : 'Rate Limiting',
    fields : [
      { key: 'rateLimitRequestsPerSecond',       label: 'Requests/sec (Global)',   type: 'number' },
      { key: 'rateLimitBurst',                   label: 'Burst (Global)',          type: 'number' },
      { key: 'rateLimitTenantRequestsPerSecond', label: 'Requests/sec (Tenant)',   type: 'number' },
      { key: 'rateLimitTenantBurst',             label: 'Burst (Tenant)',          type: 'number' },
    ],
  },
];

export function Configuration({ path }: { path?: string }) {
  const [original, setOriginal] = useState<ConfigFields>(emptyConfig);
  const [form, setForm] = useState<ConfigFields>(emptyConfig);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const fetchConfig = async () => {
    try {
      const data = await api.getConfig();
      const config: ConfigFields = { ...emptyConfig, ...data };
      setOriginal(config);
      setForm(config);
      setError('');
    } catch (err: any) {
      setError(err.message || 'Failed to load configuration');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchConfig(); }, []);

  const handleChange = (key: keyof ConfigFields, value: string) => {
    setForm((prev) => ({
      ...prev,
      [key]: key === 'logLevel' ? value : Number(value),
    }));
    setSuccess('');
  };

  const handleSave = async () => {
    setError('');
    setSuccess('');

    const changes: Record<string, unknown> = {};
    for (const key of Object.keys(form) as (keyof ConfigFields)[]) {
      if (form[key] !== original[key]) {
        changes[key] = form[key];
      }
    }

    if (Object.keys(changes).length === 0) {
      setSuccess('No changes to save.');
      return;
    }

    setSaving(true);
    try {
      await api.patchConfig(changes);
      setOriginal({ ...form });
      setSuccess('Configuration saved successfully.');
    } catch (err: any) {
      setError(err.message || 'Failed to save configuration');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div class="loading">Loading configuration...</div>;
  }

  return (
    <div>
      <div class="page-header">
        <h2>Configuration</h2>
        <p class="description">Runtime server settings</p>
      </div>

      {error && <div class="card" style="color:var(--color-danger)">{error}</div>}
      {success && <div class="card" style="color:var(--color-success)">{success}</div>}

      {fieldGroups.map((group) => (
        <div class="card" key={group.title}>
          <div class="card-header">
            <h3>{group.title}</h3>
          </div>
          {group.fields.map((field) => (
            <div class="form-group" key={field.key}>
              <label>{field.label}</label>
              <input
                type={field.type}
                value={form[field.key]}
                onInput={(e: Event) =>
                  handleChange(field.key, (e.target as HTMLInputElement).value)
                }
              />
            </div>
          ))}
        </div>
      ))}

      <button type="button" class="btn btn-primary" onClick={handleSave} disabled={saving}>
        {saving ? 'Saving...' : 'Save Changes'}
      </button>
    </div>
  );
}
