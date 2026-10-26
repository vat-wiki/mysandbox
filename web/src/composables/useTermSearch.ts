// 终端搜索浮层的状态与动作（从 Terminal.vue 抽出，2026-10-26）：Ctrl+F 打开、
// Enter/Shift+Enter 跳转、Esc 关闭。只依赖 SearchAddon 与 term.focus()，不碰 WS。
import { computed, nextTick, ref } from 'vue'
import type { SearchAddon } from '@xterm/addon-search'
import type { Terminal as XTerm } from '@xterm/xterm'

export interface TermSearchDeps {
  addon: () => SearchAddon | null
  term: () => XTerm | null
}

export function useTermSearch(deps: TermSearchDeps) {
  const searchVisible = ref(false)
  const searchQuery = ref('')
  const searchInput = ref<HTMLInputElement | null>(null)
  const searchResultIndex = ref(-1)
  const searchResultCount = ref(0)
  const searchCaseSensitive = ref(false)
  const searchRegex = ref(false)
  const searchWholeWord = ref(false)
  // 输入框宽度按显示宽度算（CJK 记 2 列）：空查询按 placeholder 字数占位。
  const searchInputWidth = computed(() => {
    const text = searchQuery.value || '搜索终端…'
    const units = [...text].reduce((width, char) => width + ((char.codePointAt(0) ?? 0) > 0xff ? 2 : 1), 0)
    return `${Math.max(8, units + 1)}ch`
  })

  // 搜索选项固定开装饰：xterm 的全部高亮和结果统计只有在 decorations 启用时才工作。
  // incremental 让输入过程中的命中延续选区，避免每敲一个字符都从头跳一遍。
  function searchOptions() {
    return {
      caseSensitive: searchCaseSensitive.value,
      regex: searchRegex.value,
      wholeWord: searchWholeWord.value,
      incremental: true,
      decorations: {
        matchBackground: '#3f3f46',
        matchBorder: '#52525b',
        matchOverviewRuler: '#71717a',
        activeMatchBackground: '#b45309',
        activeMatchBorder: '#fbbf24',
        activeMatchColorOverviewRuler: '#fbbf24',
      },
    }
  }

  function runSearch(direction: 'next' | 'previous') {
    const addon = deps.addon()
    if (!addon || !searchQuery.value) {
      searchResultIndex.value = -1
      searchResultCount.value = 0
      addon?.clearDecorations()
      return
    }
    const query = searchQuery.value
    if (direction === 'next') addon.findNext(query, searchOptions())
    else addon.findPrevious(query, searchOptions())
  }

  function openSearch() {
    searchVisible.value = true
    void nextTick(() => {
      searchInput.value?.focus()
      searchInput.value?.select()
      runSearch('next')
    })
  }

  function closeSearch() {
    searchVisible.value = false
    searchQuery.value = ''
    searchResultIndex.value = -1
    searchResultCount.value = 0
    deps.addon()?.clearDecorations()
    deps.term()?.focus()
  }

  // SearchAddon 的结果回调：onMounted 注册时接到这里。
  function setResults(index: number, count: number) {
    searchResultIndex.value = index
    searchResultCount.value = count
  }

  function toggleCaseSensitive() {
    searchCaseSensitive.value = !searchCaseSensitive.value
    runSearch('next')
  }
  function toggleWholeWord() {
    searchWholeWord.value = !searchWholeWord.value
    runSearch('next')
  }
  function toggleRegex() {
    searchRegex.value = !searchRegex.value
    runSearch('next')
  }

  return {
    searchVisible,
    searchQuery,
    searchInput,
    searchInputWidth,
    searchResultIndex,
    searchResultCount,
    searchCaseSensitive,
    searchRegex,
    searchWholeWord,
    runSearch,
    openSearch,
    closeSearch,
    setResults,
    toggleCaseSensitive,
    toggleWholeWord,
    toggleRegex,
  }
}
