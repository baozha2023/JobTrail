import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebNetwork, type WebResponse } from '../src/main/services/web-network'
import { WebPageCache } from '../src/main/services/web-page-cache'
import { WebRetrievalService } from '../src/main/services/web-retrieval-service'

const services: WebRetrievalService[] = []
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()))
})

function serviceFor(pages: Record<string, string>): WebRetrievalService {
  const network = new WebNetwork()
  vi.spyOn(network, 'request').mockImplementation(async (url) => {
    const html = pages[new URL(url).pathname]
    if (!html) throw new Error(`Unexpected URL: ${url}`)
    return {
      url,
      status: 200,
      contentType: 'text/html',
      body: Buffer.from(html),
    } satisfies WebResponse
  })
  const service = new WebRetrievalService(network)
  services.push(service)
  return service
}

const read = (service: WebRetrievalService, cursor?: string) =>
  service.read(
    { url: 'https://jobs.example.test/jobs', scroll: true, ...(cursor ? { cursor } : {}) },
    new AbortController().signal,
  )

describe('single-cursor infinite scrolling', () => {
  it('keeps short text in repeated content blocks', async () => {
    const service = serviceFor({
      '/jobs':
        '<html><body><main><ul><li>甲一</li><li>甲二</li><li>甲三</li></ul></main></body></html>',
    })
    const result = await read(service)
    expect(result.text).toContain('甲一')
    expect(result.text).toContain('甲三')
  }, 30_000)

  it('marks oversized dynamic DOM capture incomplete', async () => {
    const service = serviceFor({
      '/jobs': `<html><body><main id="feed"></main><script>
        document.getElementById('feed').innerHTML = '<div class="feed-item">内容</div>'.repeat(20_100);
      </script></body></html>`,
    })
    const result = await read(service)
    expect(result.text).toContain('内容')
    expect(result.incompleteReason).toMatch(/上限/)
    expect(result.nextCursor).toBeNull()
  }, 30_000)

  it('reads a generic news feed without links and caps each response at 20,000 characters', async () => {
    const article = '新闻正文'.repeat(900)
    const service = serviceFor({
      '/jobs': `<html><body><main><div id="feed">${Array.from(
        { length: 8 },
        (_, index) => `<div class="feed-entry" style="height:260px">第${index}条 ${article}</div>`,
      ).join('')}</div></main><script>
        let added = false;
        addEventListener('scroll', () => {
          if (added || scrollY + innerHeight < document.documentElement.scrollHeight - 50) return;
          added = true;
          document.getElementById('feed').insertAdjacentHTML('beforeend', '<div class="feed-entry" style="height:260px">滚动新增资讯</div>');
        });
      </script></body></html>`,
    })
    const chunks: string[] = []
    let response = await read(service)
    while (response.nextCursor && chunks.length < 20) {
      expect(response.text.length).toBeLessThanOrEqual(20_000)
      chunks.push(response.text)
      response = await read(service, response.nextCursor)
    }
    chunks.push(response.text)
    expect(chunks.join(' ')).toContain('第0条')
    expect(chunks.join(' ')).toContain('滚动新增资讯')
  }, 30_000)

  it('extracts repeated clickable cards that have no anchor elements', async () => {
    const service = serviceFor({
      '/jobs': `<html><body><main><div class="STJobList">${Array.from(
        { length: 8 },
        (_, index) =>
          `<div class="STListItem" style="height:180px"><div>工程师岗位${index}</div><div>北京市</div></div>`,
      ).join('')}</div></main></body></html>`,
    })
    const first = await read(service)
    expect(first.text).toContain('工程师岗位0 北京市')
    expect(first.text).toContain('工程师岗位7 北京市')
    expect(first.nextCursor).not.toBeNull()
  }, 30_000)

  it('loads a new window-scroll batch and replays the same cursor without another scroll', async () => {
    const service = serviceFor({
      '/jobs': `<html><body><main><ul id="jobs"><li style="height:300px"><a href="/1">职位一</a></li><li style="height:300px"><a href="/2">职位二</a></li><li style="height:300px"><a href="/3">职位三</a></li></ul></main><script>
        let added = false;
        addEventListener('scroll', () => {
          if (added || scrollY + innerHeight < document.documentElement.scrollHeight - 50) return;
          added = true;
          document.getElementById('jobs').insertAdjacentHTML('beforeend', '<li style="height:300px"><a href="/4">职位四</a></li><li style="height:300px"><a href="/5">职位五</a></li>');
        });
      </script></body></html>`,
    })
    const first = await read(service)
    expect(first.text).toContain('职位一')
    expect(first.text).not.toContain('职位四')
    expect(first.nextCursor).toMatch(/^wr_/)
    const second = await read(service, first.nextCursor!)
    expect(second.text).toContain('职位四')
    expect(second.links.some((link) => link.url.endsWith('/4'))).toBe(true)
    expect(await read(service, first.nextCursor!)).toEqual(second)
  }, 30_000)

  it('returns changed content without repeating an already-seen link', async () => {
    const service = serviceFor({
      '/jobs': `<html><body><main><ul><li style="height:1200px"><a href="/same">详情</a><span id="copy">旧内容</span></li></ul></main><script>
        addEventListener('scroll', () => { document.getElementById('copy').textContent = '新内容'; }, {once:true});
      </script></body></html>`,
    })
    const first = await read(service)
    expect(first.links.some((link) => link.url.endsWith('/same'))).toBe(true)
    const second = await read(service, first.nextCursor!)
    expect(second.text).toContain('新内容')
    expect(second.links).toEqual([])
  }, 30_000)

  it('scrolls a nested list instead of the document', async () => {
    const service = serviceFor({
      '/jobs': `<html><body><main><div id="list" style="height:200px;overflow-y:auto"><ul><li style="height:150px">岗位甲</li><li style="height:150px">岗位乙</li><li style="height:150px">岗位丙</li></ul></div></main><script>
        let added = false;
        document.getElementById('list').addEventListener('scroll', function () {
          if (added || this.scrollTop + this.clientHeight < this.scrollHeight - 5) return;
          added = true;
          this.querySelector('ul').insertAdjacentHTML('beforeend', '<li style="height:150px">岗位丁</li>');
        });
      </script></body></html>`,
    })
    const first = await read(service)
    const second = await read(service, first.nextCursor!)
    expect(second.text).toContain('岗位丁')
  }, 30_000)

  it('continues with another scroll container after the first reaches its bottom', async () => {
    const service = serviceFor({
      '/jobs': `<html><body><main>
        <div id="first" style="height:200px;overflow-y:auto"><ul><li style="height:150px">甲岗位一</li><li style="height:150px">甲岗位二</li><li style="height:150px">甲岗位三</li></ul></div>
        <div id="second" style="height:200px;overflow-y:auto"><ul><li style="height:150px">乙岗位一</li><li style="height:150px">乙岗位二</li><li style="height:150px">乙岗位三</li></ul></div>
      </main><script>
        for (const [id, label] of [['first','甲岗位四'], ['second','乙岗位四']]) {
          const list = document.getElementById(id);
          let added = false;
          list.addEventListener('scroll', () => {
            if (added || list.scrollTop + list.clientHeight < list.scrollHeight - 5) return;
            added = true;
            list.querySelector('ul').insertAdjacentHTML('beforeend', '<li style="height:150px">' + label + '</li>');
          });
        }
      </script></body></html>`,
    })
    let response = await read(service)
    const text = [response.text]
    for (let index = 0; response.nextCursor && index < 8; index++) {
      response = await read(service, response.nextCursor)
      text.push(response.text)
    }
    expect(text.join(' ')).toContain('甲岗位四')
    expect(text.join(' ')).toContain('乙岗位四')
  }, 30_000)

  it('captures rows replaced by a virtualized list', async () => {
    const service = serviceFor({
      '/jobs': `<html><body><main><div id="list" style="height:180px;overflow-y:auto"><ul><li style="height:150px">旧岗位一</li><li style="height:150px">旧岗位二</li><li style="height:150px">旧岗位三</li></ul></div></main><script>
        let replaced = false;
        document.getElementById('list').addEventListener('scroll', function () {
          if (replaced || this.scrollTop < 50) return;
          replaced = true;
          this.querySelector('ul').innerHTML = '<li style="height:150px">新岗位四</li><li style="height:150px">新岗位五</li><li style="height:150px">新岗位六</li>';
        });
      </script></body></html>`,
    })
    const first = await read(service)
    const second = await read(service, first.nextCursor!)
    expect(first.text).toContain('旧岗位一')
    expect(second.text).toContain('新岗位四')
    expect(second.text).not.toContain('旧岗位一')
  }, 30_000)

  it('reports incomplete content when a new scroll batch exceeds the cache budget', async () => {
    const url = 'https://jobs.example.test/jobs'
    const network = new WebNetwork()
    const added = '后续正文'.repeat(1_750)
    const html = `<html><body><main><div id="list" style="height:180px;overflow-y:auto"><ul><li style="height:150px">初始内容一</li><li style="height:150px">初始内容二</li></ul></div></main><script>
      let done = false;
      document.getElementById('list').addEventListener('scroll', () => {
        if (done) return;
        done = true;
        document.querySelector('#list ul').insertAdjacentHTML('beforeend', '<li>' + ${JSON.stringify(added)} + '</li>');
      });
    </script></body></html>`
    vi.spyOn(network, 'request').mockResolvedValue({
      url,
      status: 200,
      contentType: 'text/html',
      body: Buffer.from(html),
    })
    const service = new WebRetrievalService(
      network,
      new WebPageCache(Date.now, { maxEntries: 8, maxBytes: 12_000 }),
    )
    services.push(service)
    const first = await read(service)
    const second = await read(service, first.nextCursor!)
    expect(second.text).toContain('后续正文')
    expect(second.incompleteReason).toMatch(/缓存上限/)
    expect(second.nextCursor).toBeNull()
  }, 30_000)

  it('reads a scrolling iframe and an open shadow root', async () => {
    const service = serviceFor({
      '/jobs': `<html><body><iframe src="/frame"></iframe><div id="shadow"></div><script>
        const root = document.getElementById('shadow').attachShadow({mode:'open'});
        root.innerHTML = '<div id="list" style="height:130px;overflow-y:auto"><article style="height:120px">影子岗位一</article><article style="height:120px">影子岗位二</article></div>';
      </script></body></html>`,
      '/frame': `<html><body><main><article style="height:600px">框架岗位一</article><article style="height:600px">框架岗位二</article></main></body></html>`,
    })
    const first = await read(service)
    expect(first.text).toContain('影子岗位一')
    expect(first.text).toContain('框架岗位一')
    expect(first.nextCursor).not.toBeNull()
  }, 30_000)

  it('rejects static rendering with scroll and blocks an unknown POST without claiming completion', async () => {
    const service = serviceFor({
      '/jobs': `<html><body><main><ul><li style="height:1000px">现有岗位</li></ul></main><script>
        addEventListener('scroll', () => fetch('/api/jobs', {method:'POST', body:'{}'}));
      </script></body></html>`,
    })
    await expect(
      service.read(
        { url: 'https://jobs.example.test/jobs', scroll: true, render: 'static' },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    const first = await read(service)
    const second = await read(service, first.nextCursor!)
    expect(second.incompleteReason).toMatch(/POST/)
    expect(second.nextCursor).toBeNull()
  }, 30_000)

  it('binds the unified cursor to all read parameters and preserves concurrent replay', async () => {
    const service = serviceFor({
      '/jobs':
        '<html><body><main><ul><li style="height:1200px">岗位甲</li></ul></main></body></html>',
    })
    const first = await read(service)
    await expect(
      service.read(
        { url: 'https://jobs.example.test/jobs', cursor: first.nextCursor! },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'WEB_INVALID_CURSOR' })
    const [a, b] = await Promise.all([
      read(service, first.nextCursor!),
      read(service, first.nextCursor!),
    ])
    expect(a).toEqual(b)
    expect(a.nextCursor).toBeNull()
    expect(a.warnings.join(' ')).toContain('列表末尾')
  }, 30_000)
})
