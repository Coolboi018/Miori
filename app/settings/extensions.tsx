// Extensions — repositories as CATALOGUES, sources as INSTALLABLE items.
//
// The model this screen draws, in one line: a repository contributes sources,
// and only the installed ones run. That is why the page is two tabs — what is
// RUNNING (default) and what each repository OFFERS — instead of the old "paste
// a URL, everything appears" behaviour, which made adding a repo an all-or-
// nothing act and left the user unable to see what they had just added.
//
// WHY THIS SCREEN DOES NOT USE `SettingsPage`. That wrapper owns one ScrollView,
// which cannot carry a pinned tab strip without leaning on
// `stickyHeaderIndices` (index-fragile, and it shares one scroll offset between
// two lists of very different length — switching from a long Sources list to a
// short Installed one clamps the offset and lands you at the tail of the new
// tab). Owning the layout here gives a strip that never scrolls away and one
// fresh scroll area per tab, which is what makes the switch feel like a page
// change rather than a jump cut.
//
// NOTHING SCROLLS INSIDE THE SCROLLVIEW. The old screen put a maxHeight-limited
// `ScrollView` around the repository list, which on Android is a vertical
// scroller inside a vertical scroller and does not scroll at all
// (`nestedScrollEnabled` is not the fix — see progress.md). Repo cards and the
// preview list are plain maps; the tab's own ScrollView carries them.

import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { goBack } from '@/lib/nav/back';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/lib/ui/useTheme';
import { font, radii, spacing } from '@/lib/ui/tokens';
import { SettingRow, SettingSection, SettingSwitch } from '@/components/ui/settings';
import { AppIcon } from '@/components/ui/AppIcon';
import { useSetting, useSetSetting } from '@/lib/settings/useSetting';
import {
  applyUpdates,
  checkForUpdates,
  getInstalledSources,
  getRepoStates,
  installPreview,
  previewRepo,
  removeRepo,
  repoName,
  setRepoSources,
  type InstalledSourceInfo,
  type RepoPreview,
  type RepoSourceState,
  type RepoState,
  type UpdateReport,
} from '@/lib/extensions/registry';

type TabKey = 'installed' | 'sources';

/** Capability chips, in the order they are worth reading. */
const CAPS = [
  { key: 'subtitles', label: 'SUBS' },
  { key: 'skipMarkers', label: 'SKIP' },
  { key: 'thumbnails', label: 'ART' },
  { key: 'dub', label: 'DUB' },
] as const;

/** Tile colours for source avatars — the same saturated-literal treatment the
 *  settings index uses for its category tiles. */
const TINTS = ['#ff6b6b', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7', '#ec4899', '#06b6d4'];

function tintFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return TINTS[h % TINTS.length];
}

function initialFor(label: string): string {
  const ch = label.trim().charAt(0);
  return ch ? ch.toUpperCase() : '?';
}

function SectionTitle({ children }: { children: string }) {
  const { color } = useTheme();
  return <Text style={[styles.sectionTitle, { color: color.text.muted }]}>{children.toUpperCase()}</Text>;
}

function CapabilityChips({
  capabilities,
}: {
  capabilities: RepoSourceState['capabilities'];
}) {
  const { color } = useTheme();
  const on = CAPS.filter((c) => capabilities?.[c.key]);
  if (!on.length) return null;
  return (
    <View style={styles.chipRow}>
      {on.map((c) => (
        <View key={c.key} style={[styles.chip, { backgroundColor: color.bg.elevated }]}>
          <Text style={[styles.chipText, { color: color.text.secondary }]}>{c.label}</Text>
        </View>
      ))}
    </View>
  );
}

function SourceAvatar({ id, label }: { id: string; label: string }) {
  return (
    <View style={[styles.avatar, { backgroundColor: tintFor(id) }]}>
      <Text style={styles.avatarText}>{initialFor(label)}</Text>
    </View>
  );
}

export default function ExtensionsSettings() {
  const { color } = useTheme();
  const insets = useSafeAreaInsets();

  const repoUrls = useSetting('extensions.repoUrls') ?? [];
  const autoUpdate = useSetting('extensions.autoUpdate');
  const setSetting = useSetSetting();

  const [tab, setTab] = useState<TabKey>('installed');
  const [repos, setRepos] = useState<RepoState[]>(() => getRepoStates());
  const [installed, setInstalled] = useState<InstalledSourceInfo[]>(() => getInstalledSources());
  const [draft, setDraft] = useState('');
  const [preview, setPreview] = useState<RepoPreview | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [updates, setUpdates] = useState<UpdateReport | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgIsError, setMsgIsError] = useState(false);

  const refresh = useCallback(() => {
    setRepos(getRepoStates());
    setInstalled(getInstalledSources());
  }, []);

  // The launch sweep can finish while this page is open, and a repo added on
  // another screen must appear here too — focus is the natural sync point.
  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh])
  );

  function say(text: string, isError = false) {
    setMsg(text);
    setMsgIsError(isError);
  }

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      say((e as Error)?.message ?? String(e), true);
    } finally {
      setBusy(null);
      refresh();
    }
  }

  // --- Add flow ------------------------------------------------------------

  async function onPreview() {
    const url = draft.trim();
    if (!url) return;
    if (repoUrls.includes(url)) {
      say('That repository is already added — install its other sources below.', true);
      return;
    }
    await run('preview', async () => {
      const p = await previewRepo(url);
      setPreview(p);
      setSelected(p.sources.map((s) => s.id));
      if (!p.sources.length) say('That repository has no readable sources yet.', true);
      else if (p.skipped.length) say(`${p.skipped.length} manifest(s) could not be read.`, true);
    });
  }

  async function onInstall(ids: string[]) {
    if (!preview) return;
    const name = repoName(preview.base);
    await run('install', async () => {
      await installPreview(preview, ids);
      say(
        ids.length === 0
          ? `Added ${name} with no sources installed.`
          : `Installed ${ids.length} source${ids.length === 1 ? '' : 's'} from ${name}.`
      );
      setPreview(null);
      setSelected([]);
      setDraft('');
      // Installing is an outcome worth seeing: land on the list it changed.
      // "Add repository only" stays put, because nothing was installed.
      if (ids.length) setTab('installed');
    });
  }

  function toggleSelected(id: string) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  // --- Install / uninstall on an added repo --------------------------------

  function applyInstalled(url: string, repo: RepoState, id: string, next: boolean) {
    const ids = repo.sources
      .filter((s) => (s.id === id ? next : s.installed))
      .map((s) => s.id);
    setRepoSources(url, ids);
    refresh();
  }

  function setAllForRepo(url: string, repo: RepoState, next: boolean) {
    setRepoSources(url, next ? repo.sources.map((s) => s.id) : []);
    refresh();
  }

  /** The installed list is the cross-repo view, so uninstalling from it has to
   *  resolve the source back to the repo that owns it. */
  function uninstall(source: InstalledSourceInfo) {
    const repo = repos.find((r) => r.url === source.repoUrl);
    if (!repo) return;
    applyInstalled(repo.url, repo, source.id, false);
  }

  // --- Updates -------------------------------------------------------------

  async function onCheck() {
    await run('check', async () => {
      const report = await checkForUpdates();
      setUpdates(report);
      if (report.errors.length) {
        say(`Could not reach ${report.errors.map((e) => repoName(e.url)).join(', ')}.`, true);
      } else if (!report.updates.length) {
        say('Every source is up to date.');
      } else {
        say(`${report.updates.length} update${report.updates.length === 1 ? '' : 's'} available.`);
      }
    });
  }

  async function onApplyAll() {
    await run('apply', async () => {
      const { applied } = await applyUpdates();
      setUpdates(null);
      say(applied.length ? `Updated ${applied.length} source${applied.length === 1 ? '' : 's'}.` : 'Nothing to update.');
    });
  }

  async function onApplyOne(id: string) {
    await run(`apply:${id}`, async () => {
      await applyUpdates([id]);
      setUpdates((prev) =>
        prev ? { ...prev, updates: prev.updates.filter((u) => u.id !== id) } : prev
      );
    });
  }

  const busyAny = busy !== null;
  const updatesCount = updates?.updates.length ?? 0;
  const totalAvailable = repos.reduce((n, r) => n + r.sources.length, 0);

  const tabs: { key: TabKey; label: string; count: number }[] = [
    { key: 'installed', label: 'Installed', count: installed.length },
    { key: 'sources', label: 'Sources', count: totalAvailable },
  ];

  return (
    <View style={[styles.container, { backgroundColor: color.bg.primary }]}>
      {/* Header — same shape as SettingsPage's, kept local because this page
          owns its scroll areas (see the file header). */}
      <View style={[styles.header, { paddingTop: insets.top + spacing.md }]}>
        <Pressable
          onPress={() => goBack()}
          accessibilityRole="button"
          accessibilityLabel="Back to settings"
          hitSlop={10}
          style={styles.backHit}
        >
          <AppIcon name="back" size={22} color={color.accent.base} />
        </Pressable>
        <Text style={[styles.title, { color: color.text.primary }]}>Extensions</Text>
        <View style={styles.backSpacer} />
      </View>

      {/* The strip. Counts ride the segments so the page answers "how many do I
          run, how many exist" before a single tap. */}
      <View style={styles.tabWrap}>
        <View style={[styles.tabs, { backgroundColor: color.bg.surface }]}>
          {tabs.map((t) => {
            const active = t.key === tab;
            return (
              <Pressable
                key={t.key}
                onPress={() => setTab(t.key)}
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}
                style={({ pressed }) => [
                  styles.tab,
                  active && { backgroundColor: color.accent.base },
                  { opacity: pressed && !active ? 0.6 : 1 },
                ]}
              >
                <Text
                  style={[
                    styles.tabLabel,
                    { color: active ? color.bg.primary : color.text.secondary },
                  ]}
                >
                  {t.label}
                </Text>
                <View
                  style={[
                    styles.tabBadge,
                    active
                      ? { backgroundColor: 'rgba(128,128,128,0.28)' }
                      : { backgroundColor: color.accent.muted },
                  ]}
                >
                  <Text
                    style={[
                      styles.tabBadgeText,
                      { color: active ? color.bg.primary : color.text.muted },
                    ]}
                  >
                    {t.count}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </View>
      </View>

      {msg ? (
        <Text
          style={[styles.message, { color: msgIsError ? color.status.danger : color.text.muted }]}
        >
          {msg}
        </Text>
      ) : null}

      {tab === 'installed' ? (
        <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + spacing.giant }}>
          {/* Hero — the one number this tab is about, plus the action that keeps
              it honest. */}
          <View style={[styles.hero, { backgroundColor: color.bg.surface }]}>
            <View style={styles.heroRow}>
              <View style={styles.heroText}>
                <Text style={[styles.heroCount, { color: color.text.primary }]}>
                  {installed.length}
                </Text>
                <Text style={[styles.heroLabel, { color: color.text.muted }]}>
                  {installed.length === 1 ? 'source installed' : 'sources installed'}
                  {' · '}
                  {repoUrls.length} {repoUrls.length === 1 ? 'repository' : 'repositories'}
                </Text>
              </View>
              <Pressable
                onPress={onCheck}
                disabled={busyAny || repoUrls.length === 0}
                accessibilityRole="button"
                accessibilityLabel="Check for source updates"
                style={({ pressed }) => [
                  styles.primaryBtn,
                  {
                    backgroundColor: color.accent.base,
                    opacity: busyAny || repoUrls.length === 0 ? 0.4 : pressed ? 0.7 : 1,
                  },
                ]}
              >
                {busy === 'check' ? (
                  <ActivityIndicator size="small" color={color.bg.primary} />
                ) : (
                  <Text style={[styles.primaryBtnText, { color: color.bg.primary }]}>Check</Text>
                )}
              </Pressable>
            </View>
            {updatesCount > 0 ? (
              <Pressable
                onPress={onApplyAll}
                disabled={busyAny}
                accessibilityRole="button"
                style={({ pressed }) => [styles.updateBanner, { opacity: pressed ? 0.7 : 1 }]}
              >
                <View style={styles.updateDot} />
                <Text style={[styles.updateBannerText, { color: color.text.primary }]}>
                  {updatesCount} update{updatesCount === 1 ? '' : 's'} available
                </Text>
                <Text style={[styles.updateBannerAction, { color: color.text.secondary }]}>
                  {busy === 'apply' ? 'Updating…' : 'Update all'}
                </Text>
              </Pressable>
            ) : null}
          </View>

          {installed.length === 0 ? (
            <View style={[styles.card, styles.emptyCard, { backgroundColor: color.bg.surface }]}>
              <Text style={[styles.emptyTitle, { color: color.text.primary }]}>
                No sources installed
              </Text>
              <Text style={[styles.emptyHint, { color: color.text.muted }]}>
                A repository is a catalogue. Open Sources, pick one, and install what you want —
                only installed sources are used when you play an episode.
              </Text>
              <Pressable
                onPress={() => setTab('sources')}
                accessibilityRole="button"
                style={({ pressed }) => [styles.outlineBtn, { opacity: pressed ? 0.6 : 1 }]}
              >
                <Text style={[styles.outlineBtnText, { color: color.text.secondary }]}>
                  Browse sources
                </Text>
              </Pressable>
            </View>
          ) : (
            <View style={[styles.card, { backgroundColor: color.bg.surface }]}>
              {installed.map((s, i) => (
                <View key={s.id} style={[styles.sourceRow, i > 0 && styles.rowBorder]}>
                  <SourceAvatar id={s.id} label={s.label} />
                  <View style={styles.sourceText}>
                    <Text
                      style={[styles.sourceLabel, { color: color.text.primary }]}
                      numberOfLines={1}
                    >
                      {s.label}
                    </Text>
                    <Text
                      style={[styles.sourceMeta, { color: color.text.muted }]}
                      numberOfLines={1}
                    >
                      v{s.version}
                      {s.repoUrl ? ` · ${repoName(s.repoUrl)}` : ''}
                    </Text>
                    <CapabilityChips capabilities={s.capabilities} />
                  </View>
                  <SettingSwitch value onValueChange={() => uninstall(s)} />
                </View>
              ))}
            </View>
          )}

          <SettingSection title="Updates">
            <SettingRow
              label="Automatic updates"
              hint="Check a few seconds after launch and install new source versions."
              toggle={{
                value: autoUpdate,
                onChange: (v) => setSetting('extensions.autoUpdate', v),
              }}
            />
            {updates && updates.updates.length > 0 ? (
              <View style={styles.updateList}>
                {updates.updates.map((u, i) => (
                  <View
                    key={`${u.repoUrl}:${u.id}`}
                    style={[styles.updateRow, i > 0 && styles.rowBorder]}
                  >
                    <View style={styles.sourceText}>
                      <Text
                        style={[styles.sourceLabel, { color: color.text.primary }]}
                        numberOfLines={1}
                      >
                        {u.label}
                      </Text>
                      <Text
                        style={[styles.sourceMeta, { color: color.text.muted }]}
                        numberOfLines={1}
                      >
                        {u.from ? `v${u.from} → v${u.to}` : `new · v${u.to}`} · {repoName(u.repoUrl)}
                      </Text>
                    </View>
                    <Pressable
                      onPress={() => onApplyOne(u.id)}
                      disabled={busyAny}
                      accessibilityRole="button"
                      accessibilityLabel={`Update ${u.label}`}
                      style={({ pressed }) => [styles.outlineBtn, { opacity: pressed ? 0.6 : 1 }]}
                    >
                      <Text style={[styles.outlineBtnText, { color: color.text.secondary }]}>
                        Update
                      </Text>
                    </Pressable>
                  </View>
                ))}
              </View>
            ) : null}
          </SettingSection>
        </ScrollView>
      ) : (
        <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + spacing.giant }}>
          {/* Add — paste, see what is in it, choose. First, because adding is
              what this tab is for when it is empty. */}
          <SectionTitle>Add repository</SectionTitle>
          <View style={[styles.card, styles.addCard, { backgroundColor: color.bg.surface }]}>
            <Text style={[styles.addHint, { color: color.text.muted }]}>
              A GitHub link (or a raw base URL) whose <Text style={styles.mono}>index.json</Text>{' '}
              lists its sources. GitHub links are converted automatically.
            </Text>
            <View style={styles.inputRow}>
              <TextInput
                value={draft}
                onChangeText={setDraft}
                placeholder="https://github.com/you/your-extensions"
                placeholderTextColor={color.text.muted}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="off"
                editable={busy !== 'preview' && busy !== 'install'}
                onSubmitEditing={onPreview}
                returnKeyType="search"
                style={[
                  styles.input,
                  {
                    color: color.text.primary,
                    backgroundColor: color.bg.elevated,
                    borderColor: color.border.muted,
                  },
                ]}
              />
              <Pressable
                onPress={onPreview}
                disabled={busyAny || !draft.trim()}
                accessibilityRole="button"
                style={({ pressed }) => [
                  styles.primaryBtn,
                  {
                    backgroundColor: color.accent.base,
                    opacity: busyAny || !draft.trim() ? 0.4 : pressed ? 0.7 : 1,
                  },
                ]}
              >
                {busy === 'preview' ? (
                  <ActivityIndicator size="small" color={color.bg.primary} />
                ) : (
                  <Text style={[styles.primaryBtnText, { color: color.bg.primary }]}>Preview</Text>
                )}
              </Pressable>
            </View>

            {preview ? (
              <View style={[styles.previewCard, { backgroundColor: color.bg.elevated }]}>
                <View style={styles.previewHeader}>
                  <Text
                    style={[styles.previewName, { color: color.text.primary }]}
                    numberOfLines={1}
                  >
                    {repoName(preview.base)}
                  </Text>
                  <View style={[styles.versionTag, { backgroundColor: color.accent.muted }]}>
                    <Text style={[styles.versionTagText, { color: color.text.secondary }]}>
                      v{preview.version}
                    </Text>
                  </View>
                </View>
                {preview.changelog ? (
                  <Text style={[styles.previewChangelog, { color: color.text.muted }]}>
                    {preview.changelog}
                  </Text>
                ) : null}
                <Text style={[styles.previewCount, { color: color.text.muted }]}>
                  {preview.sources.length} source{preview.sources.length === 1 ? '' : 's'} — tap to
                  choose
                </Text>

                {preview.sources.map((s) => {
                  const on = selected.includes(s.id);
                  return (
                    <Pressable
                      key={s.id}
                      onPress={() => toggleSelected(s.id)}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: on }}
                      style={({ pressed }) => [styles.previewRow, { opacity: pressed ? 0.7 : 1 }]}
                    >
                      <View
                        style={[
                          styles.checkCircle,
                          {
                            borderColor: on ? color.accent.base : color.border.strong,
                            backgroundColor: on ? color.accent.base : 'transparent',
                          },
                        ]}
                      >
                        {on ? <AppIcon name="check" size={13} color={color.bg.primary} /> : null}
                      </View>
                      <View style={styles.sourceText}>
                        <Text
                          style={[styles.sourceLabel, { color: color.text.primary }]}
                          numberOfLines={1}
                        >
                          {s.label}
                        </Text>
                        <Text
                          style={[styles.sourceMeta, { color: color.text.muted }]}
                          numberOfLines={1}
                        >
                          v{s.version}
                        </Text>
                        <CapabilityChips capabilities={s.capabilities} />
                      </View>
                    </Pressable>
                  );
                })}

                <View style={styles.previewActions}>
                  <Pressable
                    onPress={() => onInstall(preview.sources.map((s) => s.id))}
                    disabled={busyAny || preview.sources.length === 0}
                    accessibilityRole="button"
                    style={({ pressed }) => [
                      styles.primaryBtn,
                      {
                        backgroundColor: color.accent.base,
                        opacity: busyAny || preview.sources.length === 0 ? 0.4 : pressed ? 0.7 : 1,
                      },
                    ]}
                  >
                    <Text style={[styles.primaryBtnText, { color: color.bg.primary }]}>
                      {busy === 'install' ? 'Installing…' : 'Install all'}
                    </Text>
                  </Pressable>
                  {/* Zero selected is a legitimate choice, not a disabled state:
                      adding a catalogue without running anything from it is how
                      a user parks a repo to read its sources later. */}
                  <Pressable
                    onPress={() => onInstall(selected)}
                    disabled={busyAny || preview.sources.length === 0}
                    accessibilityRole="button"
                    style={({ pressed }) => [
                      styles.outlineBtn,
                      { opacity: busyAny || preview.sources.length === 0 ? 0.4 : pressed ? 0.6 : 1 },
                    ]}
                  >
                    <Text style={[styles.outlineBtnText, { color: color.text.secondary }]}>
                      {selected.length ? `Install ${selected.length} selected` : 'Add repository only'}
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => {
                      setPreview(null);
                      setSelected([]);
                    }}
                    accessibilityRole="button"
                    style={({ pressed }) => [styles.textBtn, { opacity: pressed ? 0.5 : 1 }]}
                  >
                    <Text style={[styles.textBtnText, { color: color.text.muted }]}>Cancel</Text>
                  </Pressable>
                </View>
              </View>
            ) : null}
          </View>

          {/* Repositories — each one is a catalogue, not an install switch. */}
          <SectionTitle>Repositories</SectionTitle>
          {repos.length === 0 ? (
            <View style={[styles.card, styles.emptyCard, { backgroundColor: color.bg.surface }]}>
              <Text style={[styles.emptyHint, { color: color.text.muted }]}>
                No repositories yet. Paste a GitHub link above to see what it offers.
              </Text>
            </View>
          ) : (
            repos.map((repo) => {
              const installedHere = repo.sources.filter((s) => s.installed).length;
              return (
                <View
                  key={repo.url}
                  style={[styles.card, styles.repoCard, { backgroundColor: color.bg.surface }]}
                >
                  <View style={styles.repoHeader}>
                    <View style={[styles.repoIcon, { backgroundColor: color.accent.muted }]}>
                      <AppIcon name="database" size={16} color={color.text.primary} />
                    </View>
                    <View style={styles.repoHeaderText}>
                      <Text
                        style={[styles.repoName, { color: color.text.primary }]}
                        numberOfLines={1}
                      >
                        {repo.name}
                      </Text>
                      <Text
                        style={[styles.repoMeta, { color: color.text.muted }]}
                        numberOfLines={1}
                      >
                        {repo.sources.length} source{repo.sources.length === 1 ? '' : 's'} available
                        {' · '}
                        {installedHere} installed
                      </Text>
                    </View>
                    <Pressable
                      onPress={() => {
                        void run(`remove:${repo.url}`, async () => {
                          await removeRepo(repo.url);
                          say(`${repo.name} removed.`);
                        });
                      }}
                      disabled={busyAny}
                      accessibilityRole="button"
                      accessibilityLabel={`Remove ${repo.name}`}
                      hitSlop={8}
                      style={({ pressed }) => [styles.textBtn, { opacity: pressed ? 0.5 : 1 }]}
                    >
                      <Text style={[styles.textBtnText, { color: color.status.danger }]}>
                        Remove
                      </Text>
                    </Pressable>
                  </View>

                  {repo.sources.length === 0 ? (
                    <Text style={[styles.repoEmpty, { color: color.text.muted }]}>
                      Cached copy is empty — check for updates to fill it.
                    </Text>
                  ) : (
                    <>
                      <View style={styles.repoToolbar}>
                        <Pressable
                          onPress={() => setAllForRepo(repo.url, repo, true)}
                          accessibilityRole="button"
                          style={({ pressed }) => [
                            styles.outlineBtn,
                            { opacity: pressed ? 0.6 : 1 },
                          ]}
                        >
                          <Text style={[styles.outlineBtnText, { color: color.text.secondary }]}>
                            Install all
                          </Text>
                        </Pressable>
                        <Pressable
                          onPress={() => setAllForRepo(repo.url, repo, false)}
                          accessibilityRole="button"
                          style={({ pressed }) => [
                            styles.outlineBtn,
                            { opacity: pressed ? 0.6 : 1 },
                          ]}
                        >
                          <Text style={[styles.outlineBtnText, { color: color.text.secondary }]}>
                            Install none
                          </Text>
                        </Pressable>
                      </View>
                      {repo.sources.map((s, i) => (
                        <SourceRow
                          key={s.id}
                          source={s}
                          first={i === 0}
                          onToggle={(next) => applyInstalled(repo.url, repo, s.id, next)}
                        />
                      ))}
                    </>
                  )}
                </View>
              );
            })
          )}
        </ScrollView>
      )}
    </View>
  );
}

function SourceRow({
  source,
  first,
  onToggle,
}: {
  source: RepoSourceState;
  first: boolean;
  onToggle: (next: boolean) => void;
}) {
  const { color } = useTheme();
  return (
    <View style={[styles.sourceRow, !first && styles.rowBorder]}>
      <SourceAvatar id={source.id} label={source.label} />
      <View style={styles.sourceText}>
        <Text style={[styles.sourceLabel, { color: color.text.primary }]} numberOfLines={1}>
          {source.label}
        </Text>
        <Text style={[styles.sourceMeta, { color: color.text.muted }]} numberOfLines={1}>
          v{source.version}
          {source.shadowedBy ? ` · also in ${source.shadowedBy}` : ''}
        </Text>
        <CapabilityChips capabilities={source.capabilities} />
      </View>
      <SettingSwitch value={source.installed} onValueChange={onToggle} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    paddingBottom: spacing.sm,
  },
  backHit: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  backSpacer: { width: 44 },
  title: { flex: 1, fontSize: 17, fontFamily: font.semibold, textAlign: 'center' },

  tabWrap: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
  tabs: {
    flexDirection: 'row',
    gap: 4,
    padding: 4,
    borderRadius: radii.full,
  },
  tab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 9,
    borderRadius: radii.full,
  },
  tabLabel: { fontSize: 13.5, fontFamily: font.semibold },
  tabBadge: {
    minWidth: 20,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: radii.full,
    alignItems: 'center',
  },
  tabBadgeText: { fontSize: 10.5, fontFamily: font.bold },

  message: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    fontSize: 12.5,
    fontFamily: font.medium,
    lineHeight: 18,
  },

  hero: {
    marginHorizontal: spacing.lg,
    borderRadius: radii.lg,
    padding: spacing.lg,
    marginBottom: spacing.sm,
  },
  heroRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  heroText: { flex: 1, minWidth: 0 },
  heroCount: { fontSize: 34, fontFamily: font.bold, lineHeight: 38 },
  heroLabel: { fontSize: 12, fontFamily: font.medium, marginTop: 2 },

  primaryBtn: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radii.full,
    minWidth: 84,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryBtnText: { fontSize: 13, fontFamily: font.semibold },

  outlineBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radii.full,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(128,128,128,0.4)',
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'flex-start',
  },
  outlineBtnText: { fontSize: 12, fontFamily: font.semibold },

  textBtn: { paddingHorizontal: spacing.sm, paddingVertical: 6 },
  textBtnText: { fontSize: 12, fontFamily: font.semibold },

  updateBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(128,128,128,0.25)',
  },
  updateDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#f59e0b' },
  updateBannerText: { flex: 1, fontSize: 13, fontFamily: font.medium },
  updateBannerAction: { fontSize: 13, fontFamily: font.semibold },

  sectionTitle: {
    fontSize: 11,
    fontFamily: font.bold,
    letterSpacing: 1.2,
    marginHorizontal: spacing.lg + 4,
    marginTop: spacing.xl,
    marginBottom: spacing.sm,
  },
  card: { marginHorizontal: spacing.lg, borderRadius: radii.lg, overflow: 'hidden' },
  emptyCard: { padding: spacing.lg, gap: spacing.xs, alignItems: 'flex-start' },
  emptyTitle: { fontSize: 15, fontFamily: font.semibold },
  emptyHint: { fontSize: 13, fontFamily: font.regular, lineHeight: 19 },

  repoCard: { marginBottom: spacing.sm, paddingBottom: spacing.xs },
  repoHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  repoIcon: {
    width: 30,
    height: 30,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  repoHeaderText: { flex: 1, minWidth: 0 },
  repoName: { fontSize: 15, fontFamily: font.semibold },
  repoMeta: { fontSize: 11, fontFamily: font.medium, marginTop: 2 },
  repoEmpty: {
    fontSize: 12,
    fontFamily: font.regular,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
  },
  repoToolbar: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
  },

  sourceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
  },
  rowBorder: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(128,128,128,0.18)',
  },
  avatar: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: '#ffffff', fontSize: 15, fontFamily: font.bold },
  sourceText: { flex: 1, minWidth: 0 },
  sourceLabel: { fontSize: 14, fontFamily: font.medium },
  sourceMeta: { fontSize: 11, fontFamily: font.regular, marginTop: 1 },

  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 4 },
  chip: { paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4 },
  chipText: { fontSize: 8, fontFamily: font.bold, letterSpacing: 0.5 },

  addCard: { padding: spacing.md, gap: spacing.md },
  addHint: { fontSize: 12, fontFamily: font.regular, lineHeight: 18 },
  mono: { fontFamily: font.mono, fontSize: 11 },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  input: {
    flex: 1,
    fontFamily: font.regular,
    fontSize: 13,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },

  previewCard: {
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.xs,
  },
  previewHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  previewName: { flex: 1, fontSize: 15, fontFamily: font.semibold },
  versionTag: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  versionTagText: { fontSize: 10, fontFamily: font.bold, letterSpacing: 0.4 },
  previewChangelog: { fontSize: 12, fontFamily: font.regular, lineHeight: 17 },
  previewCount: {
    fontSize: 10,
    fontFamily: font.bold,
    letterSpacing: 0.8,
    marginTop: spacing.xs,
    marginBottom: 2,
  },
  previewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: 8,
  },
  checkCircle: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.sm,
    flexWrap: 'wrap',
  },

  updateList: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(128,128,128,0.18)',
  },
  updateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
});
