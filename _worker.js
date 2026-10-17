import { connect as cfConnect } from 'cloudflare:sockets';

const WEBHOOK = '/endpoint';
const NOTIFY_INTERVAL = 3600 * 1000;
const enable_notification = true; // 是否开启新消息提醒

const DoH缓存 = {};
const DoH缓存最大条目 = 256;
const DoH记录类型映射 = { A: 1, NS: 2, CNAME: 5, MX: 15, TXT: 16, AAAA: 28 };
const 连接超时毫秒 = 1500;
const 默认并发拨号数 = 2;

const 特征码 = [
	(Proxy.name + "IP").toUpperCase(),
	(String.fromCharCode(67, 109) + URL.name[2] + 'i' + URL.name[0]).toLowerCase()
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === WEBHOOK) {
      return handleWebhook(request, env, ctx);
    } else if (url.pathname === '/registerWebhook') {
      return registerWebhook(request, env);
    } else if (url.pathname === '/unRegisterWebhook') {
      return unRegisterWebhook(env);
    }
    return new Response('No handler for this request');
  }
};


function apiUrl(env, methodName, params = null) {
  let query = params ? '?' + new URLSearchParams(params).toString() : '';
  return `https://api.telegram.org/bot${env.ENV_BOT_TOKEN}/${methodName}${query}`;
}

async function requestTelegram(env, methodName, body, params = null) {
  return fetch(apiUrl(env, methodName, params), body).then(r => r.json());
}

function makeReqBody(body) {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function sendMessage(env, msg = {}) { return requestTelegram(env, 'sendMessage', makeReqBody(msg)); }
function copyMessage(env, msg = {}) { return requestTelegram(env, 'copyMessage', makeReqBody(msg)); }
function forwardMessage(env, msg) { return requestTelegram(env, 'forwardMessage', makeReqBody(msg)); }
function deleteMessage(env, chat_id, message_id) { return requestTelegram(env, 'deleteMessage', makeReqBody({ chat_id, message_id })); }
function sendPlainText(env, chatId, text) { return sendMessage(env, { chat_id: chatId, text }); }


async function handleWebhook(request, env, ctx) {
  if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.ENV_BOT_SECRET) {
    return new Response('Unauthorized', { status: 403 });
  }
  const update = await request.json();
  ctx.waitUntil(onUpdate(update, env, request));
  return new Response('Ok');
}

async function onUpdate(update, env, request) {
  if ('message' in update) {
    await onMessage(update.message, env, request);
  }
}

async function onMessage(message, env, request) {
  const text = message.text || message.caption || '';
  const chatId = message.chat.id.toString();
  const ADMIN_UID = env.ENV_ADMIN_UID;

  if (text === '/start') {
    let startMsg = "👋 你好！我是专属机器人管家。\n\n请直接发送您想说的话，我会立刻为您转达。";
    return sendPlainText(env, message.chat.id, startMsg);
  }

  if (chatId === ADMIN_UID) {
    if (text === '/aiopen') {
      await env.nfd.put('ai-status', 'true');
      return sendPlainText(env, ADMIN_UID, '🟢 AI 助理与风控已开启！');
    }
    if (text === '/aiclose') {
      await env.nfd.put('ai-status', 'false');
      return sendPlainText(env, ADMIN_UID, '🔴 AI 助理与风控已关闭！');
    }

    if (text.startsWith('/banlist')) {
      let parts = text.split(' ');
      let action = parts[1];
      let word = parts.slice(2).join(' ');
      let list = await env.nfd.get('banlist', { type: 'json' }) || [];
      
      if (action === 'add' && word) {
        list.push(word);
        await env.nfd.put('banlist', JSON.stringify([...new Set(list)]));
        return sendPlainText(env, ADMIN_UID, `✅ 已添加黑名单规则: ${word}`);
      } else if (action === 'rm' && word) {
        list = list.filter(w => w !== word);
        await env.nfd.put('banlist', JSON.stringify(list));
        return sendPlainText(env, ADMIN_UID, `✅ 已移除黑名单规则: ${word}`);
      } else if (action === 'ls') {
        return sendPlainText(env, ADMIN_UID, `📋 当前屏蔽黑名单:\n${list.join('\n') || '无'}`);
      } else {
        return sendPlainText(env, ADMIN_UID, `格式错误。\n添加: /banlist add 关键词或正则\n删除: /banlist rm 关键词或正则\n查看: /banlist ls`);
      }
    }

    if (!message?.reply_to_message?.chat) {
      let aiStatus = await env.nfd.get('ai-status');
      if (aiStatus === 'true' && text) return handleAdminAIChat(text, env, request);
      return sendPlainText(env, ADMIN_UID, '使用方法：回复访客消息以执行指令。AI聊天请先开启 /aiopen。黑名单请用 /banlist');
    }

    let mapDataStr = await env.nfd.get('msg-map-' + message.reply_to_message.message_id);
    if (mapDataStr) {
      let guestChatId, guestMsgId;
      try {
        let parsed = JSON.parse(mapDataStr);
        guestChatId = parsed.chatId;
        guestMsgId = parsed.messageId;
      } catch (e) {
        guestChatId = mapDataStr; 
      }

      if (text && /^\/block$/.exec(text)) return handleBlock(guestChatId, env);
      if (text && /^\/unblock$/.exec(text)) return handleUnBlock(guestChatId, env);
      if (text && /^\/checkblock$/.exec(text)) return checkBlock(guestChatId, env);
      if (text && /^\/recall$/.exec(text)) {
        if (guestMsgId) {
          await deleteMessage(env, guestChatId, guestMsgId);
          return sendPlainText(env, ADMIN_UID, '🗑️ 已撤回访客发来的原消息');
        } else {
          return sendPlainText(env, ADMIN_UID, '⚠️ 无法撤回旧数据。');
        }
      }

      return copyMessage(env, {
        chat_id: guestChatId,
        from_chat_id: message.chat.id,
        message_id: message.message_id,
        reply_to_message_id: guestMsgId
      });
    }
    return new Response('Ok');
  }

  return handleGuestMessage(message, env, request);
}

async function handleGuestMessage(message, env, request) {
  let chatId = message.chat.id;
  const text = message.text || message.caption || '';
  const ADMIN_UID = env.ENV_ADMIN_UID;

  let isblocked = await env.nfd.get('isblocked-' + chatId, { type: "json" });
  if (isblocked) return new Response('ok');

  let banlist = await env.nfd.get('banlist', { type: 'json' }) || [];
  let hitKeyword = null;
  for (let kw of banlist) {
    try {
      if (new RegExp(kw, 'i').test(text)) { hitKeyword = kw; break; }
    } catch(e) {
      if (text.includes(kw)) { hitKeyword = kw; break; }
    }
  }

  let isSpam = !!hitKeyword;
  let spamReason = hitKeyword ? `触发黑名单规则: ${hitKeyword}` : "";

  let aiStatus = await env.nfd.get('ai-status');
  if (aiStatus === 'true' && text.length > 0) {
    let promptText = text;
    if (hitKeyword) promptText = `该消息命中黑名单词“${hitKeyword}”。\n消息原文：${text}`;
    
    let aiResult = await evaluateGuestSpam(promptText, env, request);
    if (aiResult && aiResult.isSpam) {
      isSpam = true;
      spamReason = aiResult.reason;
    } else if (hitKeyword) {
      spamReason += " (AI虽放行但触发硬性黑名单)";
    }
  }

  if (isSpam) {
    await env.nfd.put('isblocked-' + chatId, true);
    const logData = { time: new Date().toLocaleString(), reason: spamReason, content: text };
    await env.nfd.put('block-log-' + chatId, JSON.stringify(logData));
    
    await deleteMessage(env, chatId, message.message_id); 
    return sendMessage(env, {
      chat_id: ADMIN_UID,
      text: `🛡️ **自动拦截报告**\n\n已自动拉黑 UID: \`${chatId}\`\n**拦截原因**：${spamReason}\n**消息原文**：${text}`,
      parse_mode: 'Markdown'
    });
  }

  let forwardReq = await forwardMessage(env, {
    chat_id: ADMIN_UID,
    from_chat_id: message.chat.id,
    message_id: message.message_id
  });

  if (forwardReq.ok) {
    await env.nfd.put('msg-map-' + forwardReq.result.message_id, JSON.stringify({
      chatId: chatId,
      messageId: message.message_id
    }));
  }
  return handleNotify(message, env);
}

async function handleNotify(message, env) {
  let chatId = message.chat.id;
  if (enable_notification) {
    let lastMsgTime = await env.nfd.get('lastmsg-' + chatId, { type: "json" });
    if (!lastMsgTime || Date.now() - lastMsgTime > NOTIFY_INTERVAL) {
      await env.nfd.put('lastmsg-' + chatId, Date.now());
      let txt = `🔔 提示：有新访客正在向您发送消息。`; 
      return sendPlainText(env, env.ENV_ADMIN_UID, txt);
    }
  }
}

async function fetchAI(payload, env, request) {
  let baseUrl = env.ENV_AI_BASE_URL || 'https://api.openai.com/v1';
  let apiUrl = baseUrl;
  
  if(!apiUrl.endsWith('/chat/completions')) {
    apiUrl = apiUrl.replace(/\/+$/, '') + '/chat/completions';
  }
  
  let headers = { 
    'Content-Type': 'application/json', 
    'Authorization': `Bearer ${env.ENV_AI_TOKEN}` 
  };

  let res = await fetchViaCfip(request, env, apiUrl, { 
    method: 'POST', 
    headers: headers, 
    body: JSON.stringify(payload),
    forceCfip: false 
  });
  
  if (!res.ok) {
    let errText = await res.text();
    throw new Error(`API HTTP ${res.status}: ${errText.substring(0, 150)}`);
  }
  return res.json();
}

async function evaluateGuestSpam(text, env, request) {
  try {
    const payload = {
      model: env.ENV_AI_MODEL || 'gpt-4o-mini',
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "你是一个严格的反垃圾/反诈骗风控引擎。请判断用户的消息是否属于广告、引流、买卖或诈骗。你必须且只能返回纯JSON格式，例如：{\"isSpam\": true, \"reason\": \"说明\"}。不要输出任何其他多余文本。" },
        { role: "user", content: text }
      ]
    };
    let data = await fetchAI(payload, env, request);
    let content = data.choices[0].message.content;
    let jsonMatch = content.match(/\{[\s\S]*\}/);
    if(jsonMatch) return JSON.parse(jsonMatch[0]);
    return JSON.parse(content);
  } catch(e) {
    console.error(e);
    return { isSpam: false, reason: "AI判定解析异常" };
  }
}

async function handleAdminAIChat(userText, env, request) {
  const tools = [
    { type: "function", function: { name: "get_block_log", description: "查询某个UID的拦截原因和拉黑日志", parameters: { type: "object", properties: { uid: { type: "string" } }, required: ["uid"] } } },
    { type: "function", function: { name: "unblock_user", description: "解除屏蔽某用户的UID", parameters: { type: "object", properties: { uid: { type: "string" } }, required: ["uid"] } } },
    { type: "function", function: { name: "count_kv", description: "统计数据库中的真实数据记录数", parameters: { type: "object", properties: {}, required: [] } } }
  ];

  const payload = {
    model: env.ENV_AI_MODEL || 'gpt-4o-mini',
    messages: [
      { role: "system", content: "你是主人的全能 Telegram 机器人管家。你有权限调用工具查拉黑记录、解封用户、或者统计数据库容量。遇到无法确定的数据务必调用工具查询，不要瞎编。" },
      { role: "user", content: userText }
    ],
    tools: tools,
    tool_choice: "auto"
  };

  try {
    let data = await fetchAI(payload, env, request);
    let responseMsg = data.choices[0].message;

    if (responseMsg.tool_calls && responseMsg.tool_calls.length > 0) {
      let call = responseMsg.tool_calls[0];
      let args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      let toolResultText = '';

      if (call.function.name === 'get_block_log') {
        let log = await env.nfd.get('block-log-' + args.uid);
        toolResultText = log ? `日志数据: ${log}` : `未找到 UID:${args.uid} 的拉黑日志。`;
      } else if (call.function.name === 'unblock_user') {
        await env.nfd.put('isblocked-' + args.uid, false);
        toolResultText = `已成功将 UID:${args.uid} 的状态改为未屏蔽。`;
      } else if (call.function.name === 'count_kv') {
        let list = await env.nfd.list();
        toolResultText = `目前 KV 空间中真实存在 ${list.keys.length} 条记录。`;
      }

      payload.messages.push(responseMsg);
      payload.messages.push({ role: "tool", tool_call_id: call.id, content: toolResultText });
      
      let finalData = await fetchAI(payload, env, request);
      return sendPlainText(env, env.ENV_ADMIN_UID, finalData.choices[0].message.content);
    } 
    return sendPlainText(env, env.ENV_ADMIN_UID, responseMsg.content);
  } catch (e) {
    return sendPlainText(env, env.ENV_ADMIN_UID, "🤖 AI 助理发生错误:\n" + e.message);
  }
}

async function handleBlock(guestChatId, env) {
  if (guestChatId === env.ENV_ADMIN_UID) return sendPlainText(env, env.ENV_ADMIN_UID, '不能屏蔽自己');
  await env.nfd.put('isblocked-' + guestChatId, true);
  return sendPlainText(env, env.ENV_ADMIN_UID, `✅ UID:${guestChatId} 屏蔽成功`);
}

async function handleUnBlock(guestChatId, env) {
  await env.nfd.put('isblocked-' + guestChatId, false);
  return sendPlainText(env, env.ENV_ADMIN_UID, `✅ UID:${guestChatId} 解除屏蔽成功`);
}

async function checkBlock(guestChatId, env) {
  let blocked = await env.nfd.get('isblocked-' + guestChatId, { type: "json" });
  return sendPlainText(env, env.ENV_ADMIN_UID, `ℹ️ UID:${guestChatId} 状态：${blocked ? '🚫 已屏蔽' : '✅ 正常'}`);
}

async function registerWebhook(request, env) {
  const url = new URL(request.url);
  const webhookUrl = `${url.protocol}//${url.hostname}${WEBHOOK}`;
  
  const r = await requestTelegram(env, 'setWebhook', makeReqBody({ url: webhookUrl, secret_token: env.ENV_BOT_SECRET }));
  await requestTelegram(env, 'setMyCommands', makeReqBody({
    commands: [
      { command: 'aiopen', description: '🟢 开启 AI 助理' },
      { command: 'aiclose', description: '🔴 关闭 AI 助理' },
      { command: 'banlist', description: '⛔ 黑名单管理 (如 /banlist ls)' },
      { command: 'block', description: '🚫 屏蔽此人 (需回复)' },
      { command: 'unblock', description: '✅ 解封此人 (需回复)' },
      { command: 'checkblock', description: 'ℹ️ 查状态 (需回复)' },
      { command: 'recall', description: '🗑️ 撤回原消息 (需回复)' }
    ]
  }));
  return new Response(r.ok ? 'Ok' : JSON.stringify(r, null, 2));
}

async function unRegisterWebhook(env) {
  const r = await requestTelegram(env, 'setWebhook', makeReqBody({ url: '' }));
  return new Response(r.ok ? 'Ok' : JSON.stringify(r, null, 2));
}


export async function fetchViaCfip(request, env, targetUrl, options = {}) {
	const parsedUrl = new URL(targetUrl);
	const isHttps = parsedUrl.protocol === 'https:';
	const targetHost = parsedUrl.hostname;
	const targetPort = Number(parsedUrl.port) || (isHttps ? 443 : 80);

	if (!options.forceCfip) {
		try {
			const directHeaders = new Headers(options.headers || {});
			directHeaders.set('Host', parsedUrl.host);
			const res = await fetch(parsedUrl.toString(), {
				method: options.method || 'GET',
				headers: directHeaders,
				body: options.body || null,
				redirect: 'manual'
			});
			if (res.ok || (res.status >= 300 && res.status < 400)) {
				return res;
			}
		} catch (_) {}
	}

	const tcpSocket = await connectViaCfip(request, env, targetHost, targetPort, { forceCfip: true });
	let tlsSocket = null;
	try {
		const encoder = new TextEncoder();
		const decoder = new TextDecoder();

		if (isHttps) {
			tlsSocket = new TlsClient(tcpSocket, {
				serverName: isIPHostname(targetHost) ? '' : stripIPv6Brackets(targetHost),
				insecure: true
			});
			await tlsSocket.handshake();
		}

		const pathWithSearch = (parsedUrl.pathname || '/') + (parsedUrl.search || '');
		const reqHeaders = new Headers(options.headers || {});
		reqHeaders.set('Host', parsedUrl.host);
		reqHeaders.set('Connection', 'close');
		reqHeaders.delete('Accept-Encoding');
		if (!reqHeaders.has('User-Agent')) reqHeaders.set('User-Agent', 'Mozilla/5.0');

		const bodyBytes = options.body ? 数据转Uint8Array(options.body) : new Uint8Array(0);
		if (bodyBytes.byteLength > 0) reqHeaders.set('Content-Length', String(bodyBytes.byteLength));

		let headerStr = `${options.method || 'GET'} ${pathWithSearch} HTTP/1.1\r\n`;
		for (const [k, v] of reqHeaders.entries()) headerStr += `${k}: ${v}\r\n`;
		headerStr += '\r\n';

		const requestPayload = 拼接字节数据(encoder.encode(headerStr), bodyBytes);

		if (isHttps) {
			await tlsSocket.write(requestPayload);
		} else {
			const writer = tcpSocket.writable.getWriter();
			try { await writer.write(requestPayload); } finally { try { writer.releaseLock(); } catch (e) {} }
		}

		let responseBuffer = new Uint8Array(0);
		let headerEndIndex = -1;
		let contentLength = null;
		let isChunked = false;
		const 最大响应字节 = 10 * 1024 * 1024; 

		const reader = !isHttps ? tcpSocket.readable.getReader() : null;
		try {
			while (responseBuffer.byteLength < 最大响应字节) {
				let chunk = null;
				if (isHttps) {
					chunk = await tlsSocket.read();
				} else {
					const { value, done } = await reader.read();
					chunk = done ? null : value;
				}
				if (!chunk) break;
				if (chunk.byteLength === 0) continue;

				responseBuffer = 拼接字节数据(responseBuffer, chunk);

				if (headerEndIndex === -1) {
					const crlfcrlf = 查找HTTP头结尾(responseBuffer);
					if (crlfcrlf !== -1) {
						headerEndIndex = crlfcrlf + 4;
						const headerText = decoder.decode(responseBuffer.subarray(0, headerEndIndex));
						const lengthMatch = headerText.match(/\r\nContent-Length:\s*(\d+)/i);
						if (lengthMatch) contentLength = parseInt(lengthMatch[1], 10);
						isChunked = /\r\nTransfer-Encoding:\s*chunked/i.test(headerText);
					}
				}

				if (headerEndIndex !== -1) {
					if (contentLength !== null && responseBuffer.byteLength >= headerEndIndex + contentLength) break;
					if (isChunked && 检测Chunked结束(responseBuffer, headerEndIndex)) break;
				}
			}
		} finally {
			if (reader) { try { reader.releaseLock(); } catch (e) {} }
		}

		if (headerEndIndex === -1) throw new Error('无效的 HTTP 响应头');

		const rawHeaderText = decoder.decode(responseBuffer.subarray(0, headerEndIndex));
		const headerLines = rawHeaderText.split('\r\n');
		const statusMatch = (headerLines[0] || '').match(/HTTP\/\d\.\d\s+(\d+)/);
		const statusCode = statusMatch ? parseInt(statusMatch[1], 10) : 200;

		const respHeaders = new Headers();
		for (let i = 1; i < headerLines.length; i++) {
			const line = headerLines[i];
			const colonIdx = line.indexOf(':');
			if (colonIdx > 0) {
				const key = line.slice(0, colonIdx).trim();
				const val = line.slice(colonIdx + 1).trim();
				if (key.toLowerCase() !== 'transfer-encoding') respHeaders.append(key, val);
			}
		}

		let rawBody = responseBuffer.subarray(headerEndIndex);
		if (isChunked) rawBody = 解码ChunkedBody(rawBody);
		else if (contentLength !== null) rawBody = rawBody.subarray(0, contentLength);

		return new Response(rawBody, { status: statusCode, headers: respHeaders });
	} finally {
		try { tlsSocket ? tlsSocket.close() : tcpSocket?.close?.(); } catch (e) {}
	}
}

export async function connectViaCfip(request, env, targetHost, targetPort = 443, options = {}) {
	const { initialData = null, forceCfip = false, concurrentDial = Number(env?.PROXY_CONCURRENT_DIAL) || 1 } = options;
	const TCP连接 = 创建安全TCP连接器(request);

	let cfipConfig = env?.cfip || env?.CFIP || '';
	let 启用兜底 = false;
	if (!cfipConfig) {
		const colo = request?.cf?.colo || 'sjc';
		cfipConfig = `${colo}.${特征码[0]}.${特征码[1]}ssss.net`.toLowerCase();
		启用兜底 = true;
	}

	async function 等待连接建立(sock, timeoutMs = 连接超时毫秒) {
		try { sock.closed?.catch?.(() => {}); } catch (e) {}
		await Promise.race([sock.opened, new Promise((_, reject) => setTimeout(() => reject(new Error('连接超时')), timeoutMs))]);
	}

	async function 打开单路TCP(address, port) {
		const sock = TCP连接({ hostname: stripIPv6Brackets(address), port: Number(port) });
		try { await 等待连接建立(sock); return sock; } 
		catch (err) { try { sock?.close?.(); } catch (e) {} throw err; }
	}

	async function 写入首包(sock, data) {
		if (!data || 有效数据长度(data) <= 0) return;
		const writer = sock.writable.getWriter();
		try { await writer.write(数据转Uint8Array(data)); } finally { try { writer.releaseLock(); } catch (e) {} }
	}

	async function 并发竞速连接(候选列表) {
		if (候选列表.length === 1) return { socket: await 打开单路TCP(候选列表[0].hostname, 候选列表[0].port), candidate: 候选列表[0] };
		const attempts = 候选列表.map(候选 => 打开单路TCP(候选.hostname, 候选.port).then(socket => ({ socket, candidate: 候选 })));
		let winner = null;
		try {
			winner = await Promise.any(attempts); return winner;
		} finally {
			if (winner) {
				for (const attempt of attempts) {
					attempt.then(({ socket }) => { if (socket !== winner.socket) { try { socket?.close?.(); } catch (e) {} } }).catch(() => {});
				}
			}
		}
	}

	if (!forceCfip) {
		try {
			const 直连候选 = Array.from({ length: 默认并发拨号数 }, () => ({ hostname: targetHost, port: targetPort }));
			const { socket } = await 并发竞速连接(直连候选);
			await 写入首包(socket, initialData);
			return socket;
		} catch (_) {}
	}

	const 所有反代数组 = await 解析地址端口(cfipConfig, targetHost);
	if (所有反代数组.length > 0) {
		const 实际并发数 = Math.max(1, Math.floor(concurrentDial));
		for (let i = 0; i < 所有反代数组.length; i += 实际并发数) {
			const 候选列表 = [];
			for (let j = 0; j < 实际并发数 && i + j < 所有反代数组.length; j++) {
				const [反代地址, 反代端口] = 所有反代数组[i + j];
				候选列表.push({ hostname: 反代地址, port: 反代端口 });
			}
			let socket = null;
			try {
				const 连接结果 = await 并发竞速连接(候选列表);
				socket = 连接结果.socket;
				await 写入首包(socket, initialData);
				return socket;
			} catch (err) { try { socket?.close?.(); } catch (e) {} }
		}
	}

	if (启用兜底) {
		const { socket } = await 并发竞速连接([{ hostname: targetHost, port: targetPort }]);
		await 写入首包(socket, initialData);
		return socket;
	}
	throw new Error('所有 cfip 反代节点连接均失败');
}

function 创建安全TCP连接器(request) {
	const fetcher = request?.fetcher;
	if (fetcher && typeof fetcher.connect === 'function') return (options, init) => init === undefined ? fetcher.connect(options) : fetcher.connect(options, init);
	return (options, init) => init === undefined ? cfConnect(options) : cfConnect(options, init);
}

async function 整理成数组(内容) {
	let 替换后的内容 = String(内容 || '').replace(/[\t"'\r\n]+/g, ',').replace(/,+/g, ',');
	if (替换后的内容.startsWith(',')) 替换后的内容 = 替换后的内容.slice(1);
	if (替换后的内容.endsWith(',')) 替换后的内容 = 替换后的内容.slice(0, -1);
	return 替换后的内容.split(',').map(s => s.trim()).filter(Boolean);
}

export async function 解析地址端口(proxyIP, 目标域名 = 'cloudflare.com', 种子标识 = '00000000') {
	proxyIP = String(proxyIP || '').toLowerCase();
	function 解析地址端口字符串(str) {
		let 地址 = str, 端口 = 443;
		if (str.includes(']:')) {
			const parts = str.split(']:');
			地址 = parts[0] + ']'; 端口 = parseInt(parts[1], 10) || 端口;
		} else if ((str.match(/:/g) || []).length === 1 && !str.startsWith('[')) {
			const colonIndex = str.lastIndexOf(':');
			地址 = str.slice(0, colonIndex); 端口 = parseInt(str.slice(colonIndex + 1), 10) || 端口;
		}
		return [地址, 端口];
	}
	function 解析TXT反代记录(txtData) {
		return txtData.flatMap(data => {
			if (data.startsWith('"') && data.endsWith('"')) data = data.slice(1, -1);
			return data.replace(/\\010/g, ',').replace(/\n/g, ',').split(',').map(s => s.trim()).filter(Boolean);
		}).map(prefix => 解析地址端口字符串(prefix));
	}
	const 反代IP数组 = await 整理成数组(proxyIP);
	let 所有反代数组 = [];
	const ipv4Regex = /^(25[0-5]|2[0-4]\d|[01]?\d\d?)\.(25[0-5]|2[0-4]\d|[01]?\d\d?)\.(25[0-5]|2[0-4]\d|[01]?\d\d?)\.(25[0-5]|2[0-4]\d|[01]?\d\d?)$/;
	const ipv6Regex = /^\[?(?:[a-fA-F0-9]{0,4}:){1,7}[a-fA-F0-9]{0,4}\]?$/;
	for (const singleProxyIP of 反代IP数组) {
		let [地址, 端口] = 解析地址端口字符串(singleProxyIP);
		if (singleProxyIP.includes('.tp')) {
			const tpMatch = singleProxyIP.match(/\.tp(\d+)/);
			if (tpMatch) 端口 = parseInt(tpMatch[1], 10);
		}
		if (ipv4Regex.test(地址) || ipv6Regex.test(地址)) { 所有反代数组.push([地址, 端口]); continue; }
		const [txtRecords, aRecords] = await Promise.all([DoH查询(地址, 'TXT'), DoH查询(地址, 'A')]);
		const txtData = txtRecords.filter(r => r.type === 16).map(r => r.data);
		const txtAddresses = 解析TXT反代记录(txtData);
		if (txtAddresses.length > 0) { 所有反代数组.push(...txtAddresses); continue; }
		const ipv4List = aRecords.filter(r => r.type === 1).map(r => r.data);
		if (ipv4List.length > 0) { 所有反代数组.push(...ipv4List.map(ip => [ip, 端口])); continue; }
		const aaaaRecords = await DoH查询(地址, 'AAAA');
		const ipv6List = aaaaRecords.filter(r => r.type === 28).map(r => `[${r.data}]`);
		if (ipv6List.length > 0) 所有反代数组.push(...ipv6List.map(ip => [ip, 端口]));
		else 所有反代数组.push([地址, 端口]);
	}
	const 排序后数组 = 所有反代数组.sort((a, b) => a[0].localeCompare(b[0]));
	const 目标根域名 = 目标域名.includes('.') ? 目标域名.split('.').slice(-2).join('.') : 目标域名;
	let 随机种子 = [...(目标根域名 + 种子标识)].reduce((a, c) => a + c.charCodeAt(0), 0);
	const 洗牌后 = [...排序后数组].sort(() => (随机种子 = (随机种子 * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5);
	return 洗牌后.slice(0, 8);
}

async function DoH查询(域名, 记录类型, DoH解析服务 = "https://cloudflare-dns.com/dns-query") {
	const 规范化域名 = String(域名 || '').trim().toLowerCase().replace(/\.$/, '');
	const 规范化记录类型 = String(记录类型 || '').trim().toUpperCase();
	const 缓存键 = `${规范化域名}:${规范化记录类型}`;
	const qtype = DoH记录类型映射[规范化记录类型] || 1;
	const 当前时间戳 = Date.now();
	const 现缓存项 = DoH缓存[缓存键];
	if (现缓存项 && 当前时间戳 < 现缓存项.过期时间) return 现缓存项.data.map(data => ({ type: qtype, data }));

	try {
		const 编码域名 = (name) => {
			const parts = name.endsWith('.') ? name.slice(0, -1).split('.') : name.split('.');
			const bufs = [];
			for (const label of parts) {
				const enc = new TextEncoder().encode(label); bufs.push(new Uint8Array([enc.length]), enc);
			}
			bufs.push(new Uint8Array([0])); return 拼接字节数据(...bufs);
		};
		const qname = 编码域名(规范化域名);
		const query = new Uint8Array(12 + qname.length + 4);
		const qview = new DataView(query.buffer);
		qview.setUint16(0, crypto.getRandomValues(new Uint16Array(1))[0]);
		qview.setUint16(2, 0x0100); qview.setUint16(4, 1);
		query.set(qname, 12);
		qview.setUint16(12 + qname.length, qtype); qview.setUint16(12 + qname.length + 2, 1);

		const response = await fetch(DoH解析服务, {
			method: 'POST',
			headers: { 'Content-Type': 'application/dns-message', 'Accept': 'application/dns-message' },
			body: query,
		});
		if (!response.ok) return [];

		const buf = new Uint8Array(await response.arrayBuffer());
		const dv = new DataView(buf.buffer);
		const qdcount = dv.getUint16(4); const ancount = dv.getUint16(6);

		const 解析域名 = (pos) => {
			const labels = [];
			let p = pos, jumped = false, endPos = -1, safe = 128;
			while (p < buf.length && safe-- > 0) {
				const len = buf[p];
				if (len === 0) { if (!jumped) endPos = p + 1; break; }
				if ((len & 0xC0) === 0xC0) {
					if (!jumped) endPos = p + 2;
					p = ((len & 0x3F) << 8) | buf[p + 1];
					jumped = true; continue;
				}
				labels.push(new TextDecoder().decode(buf.slice(p + 1, p + 1 + len)));
				p += len + 1;
			}
			if (endPos === -1) endPos = p + 1;
			return [labels.join('.'), endPos];
		};

		let offset = 12;
		for (let i = 0; i < qdcount; i++) { const [, end] = 解析域名(offset); offset = end + 4; }

		const answers = [];
		for (let i = 0; i < ancount && offset < buf.length; i++) {
			const [name, nameEnd] = 解析域名(offset); offset = nameEnd;
			const type = dv.getUint16(offset); offset += 2; offset += 2;
			const ttl = dv.getUint32(offset); offset += 4;
			const rdlen = dv.getUint16(offset); offset += 2;
			const rdata = buf.slice(offset, offset + rdlen); offset += rdlen;

			let data;
			if (type === 1 && rdlen === 4) data = `${rdata[0]}.${rdata[1]}.${rdata[2]}.${rdata[3]}`;
			else if (type === 28 && rdlen === 16) {
				const segs = [];
				for (let j = 0; j < 16; j += 2) segs.push(((rdata[j] << 8) | rdata[j + 1]).toString(16));
				data = segs.join(':');
			} else if (type === 16) {
				let tOff = 0; const parts = [];
				while (tOff < rdlen) { const tLen = rdata[tOff++]; parts.push(new TextDecoder().decode(rdata.slice(tOff, tOff + tLen))); tOff += tLen; }
				data = parts.join('');
			} else if (type === 5) { const [cname] = 解析域名(offset - rdlen); data = cname; } 
			else data = Array.from(rdata).map(b => b.toString(16).padStart(2, '0')).join('');
			answers.push({ name, type, TTL: ttl, data, rdata });
		}

		const 相关记录 = answers.filter(a => a.type === qtype);
		const 最小TTL = 相关记录.length > 0 ? Math.min(...相关记录.map(a => a.TTL)) : 0;
		const 缓存TTL = Math.max(最小TTL, 5 * 60);
		const 缓存数据 = 相关记录.map(a => a.data);

		if (缓存数据.length > 0 || answers.length === 0) {
			if (Object.keys(DoH缓存).length >= DoH缓存最大条目) {
				const 清理时间戳 = Date.now();
				for (const [k, v] of Object.entries(DoH缓存)) if (清理时间戳 >= v.过期时间) delete DoH缓存[k];
				if (Object.keys(DoH缓存).length >= DoH缓存最大条目) delete DoH缓存[Object.keys(DoH缓存)[0]];
			}
			DoH缓存[缓存键] = { data: 缓存数据, 过期时间: Date.now() + 缓存TTL * 1000 };
		}
		return answers;
	} catch (_) { return []; }
}

function 数据转Uint8Array(data) {
	if (data instanceof Uint8Array) return data;
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	if (typeof data === 'string') return new TextEncoder().encode(data);
	return new Uint8Array(data || 0);
}
function 有效数据长度(data) {
	if (!data) return 0;
	if (typeof data.byteLength === 'number') return data.byteLength;
	if (typeof data.length === 'number') return data.length;
	return 0;
}
function 拼接字节数据(...chunkList) {
	if (!chunkList || chunkList.length === 0) return new Uint8Array(0);
	const chunks = chunkList.map(数据转Uint8Array).filter(c => c.byteLength > 0);
	const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
	const result = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) { result.set(c, offset); offset += c.byteLength; }
	return result;
}
function stripIPv6Brackets(hostname = '') {
	const host = String(hostname || '').trim();
	return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}
function isIPHostname(hostname = '') {
	const host = stripIPv6Brackets(hostname);
	const ipv4Regex = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
	if (ipv4Regex.test(host)) return true;
	if (!host.includes(':')) return false;
	try { new URL(`http://[${host}]/`); return true; } catch (e) { return false; }
}
function 查找HTTP头结尾(buf) {
	for (let i = 0; i <= buf.byteLength - 4; i++) {
		if (buf[i] === 0x0d && buf[i + 1] === 0x0a && buf[i + 2] === 0x0d && buf[i + 3] === 0x0a) return i;
	}
	return -1;
}
function 检测Chunked结束(buf, startIdx) {
	for (let i = Math.max(startIdx, buf.byteLength - 7); i <= buf.byteLength - 5; i++) {
		if (buf[i] === 0x30 && buf[i + 1] === 0x0d && buf[i + 2] === 0x0a && buf[i + 3] === 0x0d && buf[i + 4] === 0x0a) return true;
	}
	return false;
}
function 解码ChunkedBody(buf) {
	const chunks = [];
	let pos = 0;
	const decoder = new TextDecoder();
	while (pos < buf.byteLength) {
		let lineEnd = -1;
		for (let i = pos; i < buf.byteLength - 1; i++) {
			if (buf[i] === 0x0d && buf[i + 1] === 0x0a) { lineEnd = i; break; }
		}
		if (lineEnd === -1) break;
		const sizeHex = decoder.decode(buf.subarray(pos, lineEnd)).split(';')[0].trim();
		const chunkSize = parseInt(sizeHex, 16);
		if (!Number.isFinite(chunkSize) || chunkSize === 0) break;
		pos = lineEnd + 2;
		if (pos + chunkSize > buf.byteLength) { chunks.push(buf.subarray(pos)); break; }
		chunks.push(buf.subarray(pos, pos + chunkSize));
		pos += chunkSize + 2;
	}
	return 拼接字节数据(...chunks);
}

const TLS_VERSION_10 = 769, TLS_VERSION_12 = 771, TLS_VERSION_13 = 772;
const CONTENT_TYPE_CHANGE_CIPHER_SPEC = 20, CONTENT_TYPE_ALERT = 21, CONTENT_TYPE_HANDSHAKE = 22, CONTENT_TYPE_APPLICATION_DATA = 23;
const HANDSHAKE_TYPE_CLIENT_HELLO = 1, HANDSHAKE_TYPE_SERVER_HELLO = 2, HANDSHAKE_TYPE_CERTIFICATE_REQUEST = 13, HANDSHAKE_TYPE_SERVER_HELLO_DONE = 14, HANDSHAKE_TYPE_FINISHED = 20;
const HANDSHAKE_TYPE_CERTIFICATE = 11, HANDSHAKE_TYPE_SERVER_KEY_EXCHANGE = 12, HANDSHAKE_TYPE_CLIENT_KEY_EXCHANGE = 16;
const EXT_SERVER_NAME = 0, EXT_SUPPORTED_GROUPS = 10, EXT_EC_POINT_FORMATS = 11, EXT_SIGNATURE_ALGORITHMS = 13, EXT_APPLICATION_LAYER_PROTOCOL_NEGOTIATION = 16, EXT_SUPPORTED_VERSIONS = 43, EXT_PSK_KEY_EXCHANGE_MODES = 45, EXT_KEY_SHARE = 51;
const ALERT_CLOSE_NOTIFY = 0, ALERT_LEVEL_WARNING = 1, ALERT_UNRECOGNIZED_NAME = 112;
const shouldIgnoreTlsAlert = fragment => fragment?.[0] === ALERT_LEVEL_WARNING && fragment?.[1] === ALERT_UNRECOGNIZED_NAME;
const textEncoder = new TextEncoder(), textDecoder = new TextDecoder(), EMPTY_BYTES = new Uint8Array(0);
const CIPHER_SUITES_BY_ID = new Map([
	[4865, { id: 4865, keyLen: 16, ivLen: 12, hash: "SHA-256", tls13: true }],
	[4866, { id: 4866, keyLen: 32, ivLen: 12, hash: "SHA-384", tls13: true }],
	[4867, { id: 4867, keyLen: 32, ivLen: 12, hash: "SHA-256", tls13: true, chacha: true }],
	[49199, { id: 49199, keyLen: 16, ivLen: 4, hash: "SHA-256", kex: "ECDHE" }],
	[49200, { id: 49200, keyLen: 32, ivLen: 4, hash: "SHA-384", kex: "ECDHE" }],
	[52392, { id: 52392, keyLen: 32, ivLen: 12, hash: "SHA-256", kex: "ECDHE", chacha: true }],
	[49195, { id: 49195, keyLen: 16, ivLen: 4, hash: "SHA-256", kex: "ECDHE" }],
	[49196, { id: 49196, keyLen: 32, ivLen: 4, hash: "SHA-384", kex: "ECDHE" }],
	[52393, { id: 52393, keyLen: 32, ivLen: 12, hash: "SHA-256", kex: "ECDHE", chacha: true }]
]);
const GROUPS_BY_ID = new Map([[29, "X25519"], [23, "P-256"]]);
const SUPPORTED_SIGNATURE_ALGORITHMS = [2052, 2053, 2054, 1025, 1281, 1537, 1027, 1283, 1539];
const tlsBytes = (...parts) => {
	const flatten = v => v.flatMap(x => x instanceof Uint8Array ? [...x] : Array.isArray(x) ? flatten(x) : typeof x === "number" ? [x] : []);
	return new Uint8Array(flatten(parts));
};
const uint16be = v => [(v >> 8) & 255, 255 & v];
const readUint16 = (b, o) => (b[o] << 8) | b[o + 1];
const readUint24 = (b, o) => (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];
const concatBytes = (...chunks) => 拼接字节数据(...chunks);
const randomBytes = len => crypto.getRandomValues(new Uint8Array(len));
const constantTimeEqual = (a, b) => {
	if (!a || !b || a.length !== b.length) return false;
	let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
	return d === 0;
};
const hashByteLength = h => h === "SHA-512" ? 64 : h === "SHA-384" ? 48 : 32;
async function hmac(hash, key, data) {
	const ck = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash }, false, ["sign"]);
	return new Uint8Array(await crypto.subtle.sign("HMAC", ck, data));
}
async function digestBytes(hash, data) { return new Uint8Array(await crypto.subtle.digest(hash, data)); }
async function tls12Prf(secret, label, seed, length, hash = "SHA-256") {
	const labelSeed = concatBytes(textEncoder.encode(label), seed);
	let out = new Uint8Array(0), curA = labelSeed;
	while (out.length < length) {
		curA = await hmac(hash, secret, curA);
		out = concatBytes(out, await hmac(hash, secret, concatBytes(curA, labelSeed)));
	}
	return out.slice(0, length);
}
async function hkdfExtract(hash, salt, ikm) {
	if (!salt || !salt.length) salt = new Uint8Array(hashByteLength(hash));
	return hmac(hash, salt, ikm);
}
async function hkdfExpandLabel(hash, secret, label, context, length) {
	const fullLabel = textEncoder.encode("tls13 " + label);
	const info = tlsBytes(uint16be(length), fullLabel.length, fullLabel, context.length, context);
	const hashLen = hashByteLength(hash), rounds = Math.ceil(length / hashLen);
	let out = new Uint8Array(0), prev = new Uint8Array(0);
	for (let r = 1; r <= rounds; r++) {
		prev = await hmac(hash, secret, concatBytes(prev, info, [r]));
		out = concatBytes(out, prev);
	}
	return out.slice(0, length);
}
async function generateKeyShare(group = "P-256") {
	const alg = group === "X25519" ? { name: "X25519" } : { name: "ECDH", namedCurve: group };
	const keyPair = await crypto.subtle.generateKey(alg, true, ["deriveBits"]);
	const publicKeyRaw = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
	return { keyPair, publicKeyRaw };
}
async function deriveSharedSecret(privateKey, peerPublicKey, group = "P-256") {
	const alg = group === "X25519" ? { name: "X25519" } : { name: "ECDH", namedCurve: group };
	const peerKey = await crypto.subtle.importKey("raw", peerPublicKey, alg, false, []);
	const bits = group === "P-384" ? 384 : group === "P-521" ? 528 : 256;
	return new Uint8Array(await crypto.subtle.deriveBits({ name: alg.name, public: peerKey }, privateKey, bits));
}
async function importAesGcmKey(key, usages) { return crypto.subtle.importKey("raw", key, { name: "AES-GCM" }, false, usages); }
async function aesGcmEncryptWithKey(ck, iv, pt, aad) { return new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad, tagLength: 128 }, ck, pt)); }
async function aesGcmDecryptWithKey(ck, iv, ct, aad) { return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad, tagLength: 128 }, ck, ct)); }
function rotateLeft32(v, b) { return ((v << b) | (v >>> (32 - b))) >>> 0; }
function chachaQuarterRound(s, a, b, c, d) {
	s[a] = (s[a] + s[b]) >>> 0; s[d] = rotateLeft32(s[d] ^ s[a], 16);
	s[c] = (s[c] + s[d]) >>> 0; s[b] = rotateLeft32(s[b] ^ s[c], 12);
	s[a] = (s[a] + s[b]) >>> 0; s[d] = rotateLeft32(s[d] ^ s[a], 8);
	s[c] = (s[c] + s[d]) >>> 0; s[b] = rotateLeft32(s[b] ^ s[c], 7);
}
function chacha20Block(key, counter, nonce) {
	const state = new Uint32Array(16);
	state[0] = 1634760805; state[1] = 857760878; state[2] = 2036477234; state[3] = 1797285236;
	const kv = new DataView(key.buffer, key.byteOffset, key.byteLength);
	for (let i = 0; i < 8; i++) state[4 + i] = kv.getUint32(4 * i, true);
	state[12] = counter;
	const nv = new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength);
	state[13] = nv.getUint32(0, true); state[14] = nv.getUint32(4, true); state[15] = nv.getUint32(8, true);
	const ws = new Uint32Array(state);
	for (let r = 0; r < 10; r++) {
		chachaQuarterRound(ws, 0, 4, 8, 12); chachaQuarterRound(ws, 1, 5, 9, 13);
		chachaQuarterRound(ws, 2, 6, 10, 14); chachaQuarterRound(ws, 3, 7, 11, 15);
		chachaQuarterRound(ws, 0, 5, 10, 15); chachaQuarterRound(ws, 1, 6, 11, 12);
		chachaQuarterRound(ws, 2, 7, 8, 13); chachaQuarterRound(ws, 3, 4, 9, 14);
	}
	for (let i = 0; i < 16; i++) ws[i] = (ws[i] + state[i]) >>> 0;
	return new Uint8Array(ws.buffer.slice(0));
}
function chacha20Xor(key, nonce, data) {
	const out = new Uint8Array(data.length); let counter = 1;
	for (let off = 0; off < data.length; off += 64) {
		const block = chacha20Block(key, counter++, nonce), len = Math.min(64, data.length - off);
		for (let i = 0; i < len; i++) out[off + i] = data[off + i] ^ block[i];
	}
	return out;
}
function poly1305Mac(key, message) {
	const rKey = new Uint8Array(key.slice(0, 16));
	rKey[3] &= 15; rKey[7] &= 15; rKey[11] &= 15; rKey[15] &= 15; rKey[4] &= 252; rKey[8] &= 252; rKey[12] &= 252;
	const sKey = key.slice(16, 32); let acc = [0n, 0n, 0n, 0n, 0n];
	const rLimbs = [
		0x3ffffffn & BigInt(rKey[0] | (rKey[1] << 8) | (rKey[2] << 16) | (rKey[3] << 24)),
		0x3ffffffn & BigInt((rKey[3] >> 2) | (rKey[4] << 6) | (rKey[5] << 14) | (rKey[6] << 22)),
		0x3ffffffn & BigInt((rKey[6] >> 4) | (rKey[7] << 4) | (rKey[8] << 12) | (rKey[9] << 20)),
		0x3ffffffn & BigInt((rKey[9] >> 6) | (rKey[10] << 2) | (rKey[11] << 10) | (rKey[12] << 18)),
		0x3ffffffn & BigInt(rKey[13] | (rKey[14] << 8) | (rKey[15] << 16))
	];
	for (let off = 0; off < message.length; off += 16) {
		const chunk = message.slice(off, off + 16), pad = new Uint8Array(17);
		pad.set(chunk); pad[chunk.length] = 1;
		acc[0] += BigInt(pad[0] | (pad[1] << 8) | (pad[2] << 16) | ((3 & pad[3]) << 24));
		acc[1] += BigInt((pad[3] >> 2) | (pad[4] << 6) | (pad[5] << 14) | ((15 & pad[6]) << 22));
		acc[2] += BigInt((pad[6] >> 4) | (pad[7] << 4) | (pad[8] << 12) | ((63 & pad[9]) << 20));
		acc[3] += BigInt((pad[9] >> 6) | (pad[10] << 2) | (pad[11] << 10) | (pad[12] << 18));
		acc[4] += BigInt(pad[13] | (pad[14] << 8) | (pad[15] << 16) | (pad[16] << 24));
		const prod = [0n, 0n, 0n, 0n, 0n];
		for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) i + j < 5 ? (prod[i + j] += acc[i] * rLimbs[j]) : (prod[i + j - 5] += acc[i] * rLimbs[j] * 5n);
		let carry = 0n;
		for (let i = 0; i < 5; i++) { prod[i] += carry; acc[i] = 0x3ffffffn & prod[i]; carry = prod[i] >> 26n; }
		acc[0] += 5n * carry; carry = acc[0] >> 26n; acc[0] &= 0x3ffffffn; acc[1] += carry;
	}
	let tagVal = acc[0] | (acc[1] << 26n) | (acc[2] << 52n) | (acc[3] << 78n) | (acc[4] << 104n);
	tagVal = (tagVal + sKey.reduce((t, b, i) => t + (BigInt(b) << BigInt(8 * i)), 0n)) & ((1n << 128n) - 1n);
	const tag = new Uint8Array(16);
	for (let i = 0; i < 16; i++) tag[i] = Number((tagVal >> BigInt(8 * i)) & 0xffn); return tag;
}
function chacha20Poly1305Encrypt(key, nonce, pt, aad) {
	const polyKey = chacha20Block(key, 0, nonce).slice(0, 32), ct = chacha20Xor(key, nonce, pt);
	const aadPad = (16 - (aad.length % 16)) % 16, ctPad = (16 - (ct.length % 16)) % 16;
	const macData = new Uint8Array(aad.length + aadPad + ct.length + ctPad + 16);
	macData.set(aad, 0); macData.set(ct, aad.length + aadPad);
	const lv = new DataView(macData.buffer, aad.length + aadPad + ct.length + ctPad);
	lv.setBigUint64(0, BigInt(aad.length), true); lv.setBigUint64(8, BigInt(ct.length), true);
	return concatBytes(ct, poly1305Mac(polyKey, macData));
}
function chacha20Poly1305Decrypt(key, nonce, ct, aad) {
	if (ct.length < 16) throw new Error("Ciphertext too short");
	const tag = ct.slice(-16), enc = ct.slice(0, -16), polyKey = chacha20Block(key, 0, nonce).slice(0, 32);
	const aadPad = (16 - (aad.length % 16)) % 16, ctPad = (16 - (enc.length % 16)) % 16;
	const macData = new Uint8Array(aad.length + aadPad + enc.length + ctPad + 16);
	macData.set(aad, 0); macData.set(enc, aad.length + aadPad);
	const lv = new DataView(macData.buffer, aad.length + aadPad + enc.length + ctPad);
	lv.setBigUint64(0, BigInt(aad.length), true); lv.setBigUint64(8, BigInt(enc.length), true);
	const expected = poly1305Mac(polyKey, macData);
	if (!constantTimeEqual(tag, expected)) throw new Error("ChaCha20-Poly1305 auth failed");
	return chacha20Xor(key, nonce, enc);
}
const TLS_MAX_PLAINTEXT_FRAGMENT = 16 * 1024;
function buildTlsRecord(type, fragment, ver = TLS_VERSION_12) {
	const data = 数据转Uint8Array(fragment), rec = new Uint8Array(5 + data.byteLength);
	rec[0] = type; rec[1] = (ver >> 8) & 255; rec[2] = ver & 255;
	rec[3] = (data.byteLength >> 8) & 255; rec[4] = data.byteLength & 255;
	rec.set(data, 5); return rec;
}
function buildHandshakeMessage(type, body) {
	return tlsBytes(type, [(body.length >> 16) & 255, (body.length >> 8) & 255, 255 & body.length], body);
}
class TlsRecordParser {
	constructor() { this.buffer = new Uint8Array(0); }
	feed(chunk) { const b = 数据转Uint8Array(chunk); this.buffer = this.buffer.length ? concatBytes(this.buffer, b) : b; }
	next() {
		if (this.buffer.length < 5) return null;
		const type = this.buffer[0], version = readUint16(this.buffer, 1), length = readUint16(this.buffer, 3);
		if (this.buffer.length < 5 + length) return null;
		const fragment = this.buffer.subarray(5, 5 + length);
		this.buffer = this.buffer.subarray(5 + length);
		return { type, version, length, fragment };
	}
}
class TlsHandshakeParser {
	constructor() { this.buffer = new Uint8Array(0); }
	feed(chunk) { const b = 数据转Uint8Array(chunk); this.buffer = this.buffer.length ? concatBytes(this.buffer, b) : b; }
	next() {
		if (this.buffer.length < 4) return null;
		const type = this.buffer[0], length = readUint24(this.buffer, 1);
		if (this.buffer.length < 4 + length) return null;
		const body = this.buffer.subarray(4, 4 + length), raw = this.buffer.subarray(0, 4 + length);
		this.buffer = this.buffer.subarray(4 + length); return { type, length, body, raw };
	}
}
function parseServerHello(body) {
	let off = 0;
	const legacyVersion = readUint16(body, off); off += 2;
	const serverRandom = body.slice(off, off + 32); off += 32;
	const sidLen = body[off++]; off += sidLen;
	const cipherSuite = readUint16(body, off); off += 2;
	const compression = body[off++];
	let selectedVersion = legacyVersion, keyShare = null, alpn = null;
	if (off < body.length) {
		const extLen = readUint16(body, off); off += 2; const extEnd = off + extLen;
		while (off + 4 <= extEnd) {
			const eType = readUint16(body, off); off += 2; const eLen = readUint16(body, off); off += 2;
			const eData = body.slice(off, off + eLen); off += eLen;
			if (eType === EXT_SUPPORTED_VERSIONS && eLen >= 2) selectedVersion = readUint16(eData, 0);
			else if (eType === EXT_KEY_SHARE && eLen >= 4) keyShare = { group: readUint16(eData, 0), key: eData.slice(4, 4 + readUint16(eData, 2)) };
			else if (eType === EXT_APPLICATION_LAYER_PROTOCOL_NEGOTIATION && eLen >= 3) alpn = textDecoder.decode(eData.slice(3, 3 + eData[2]));
		}
	}
	return { version: legacyVersion, serverRandom, cipherSuite, compression, selectedVersion, keyShare, alpn, isTls13: selectedVersion === TLS_VERSION_13 };
}
function parseServerKeyExchange(body) {
	const namedCurve = readUint16(body, 1), keyLength = body[3];
	return { namedCurve, serverPublicKey: body.slice(4, 4 + keyLength) };
}
function buildClientHello(clientRandom, serverName, keyShares, { tls13 = true, tls12 = true, chacha = true } = {}) {
	const cipherIds = [];
	if (tls13) cipherIds.push(4865, 4866, ...(chacha ? [4867] : []));
	if (tls12) cipherIds.push(49199, 49200, 49195, 49196, ...(chacha ? [52392, 52393] : []));
	const cipherBytes = tlsBytes(...cipherIds.flatMap(uint16be)), extensions = [tlsBytes(255, 1, 0, 1, 0)];
	if (serverName) {
		const snb = textEncoder.encode(serverName), snList = tlsBytes(0, uint16be(snb.length), snb);
		extensions.push(tlsBytes(uint16be(EXT_SERVER_NAME), uint16be(snList.length + 2), uint16be(snList.length), snList));
	}
	extensions.push(tlsBytes(uint16be(EXT_EC_POINT_FORMATS), 0, 2, 1, 0));
	extensions.push(tlsBytes(uint16be(EXT_SUPPORTED_GROUPS), 0, 6, 0, 4, 0, 29, 0, 23));
	const sigBytes = tlsBytes(...SUPPORTED_SIGNATURE_ALGORITHMS.flatMap(uint16be));
	extensions.push(tlsBytes(uint16be(EXT_SIGNATURE_ALGORITHMS), uint16be(sigBytes.length + 2), uint16be(sigBytes.length), sigBytes));
	if (tls13 && keyShares) {
		extensions.push(tls12 ? tlsBytes(uint16be(EXT_SUPPORTED_VERSIONS), 0, 5, 4, 3, 4, 3, 3) : tlsBytes(uint16be(EXT_SUPPORTED_VERSIONS), 0, 3, 2, 3, 4));
		extensions.push(tlsBytes(uint16be(EXT_PSK_KEY_EXCHANGE_MODES), 0, 2, 1, 1));
		const ksBytes = concatBytes(tlsBytes(0, 29, uint16be(keyShares.x25519.length), keyShares.x25519), tlsBytes(0, 23, uint16be(keyShares.p256.length), keyShares.p256));
		extensions.push(tlsBytes(uint16be(EXT_KEY_SHARE), uint16be(ksBytes.length + 2), uint16be(ksBytes.length), ksBytes));
	}
	const extBytes = concatBytes(...extensions);
	return buildHandshakeMessage(HANDSHAKE_TYPE_CLIENT_HELLO, tlsBytes(uint16be(TLS_VERSION_12), clientRandom, 0, uint16be(cipherBytes.length), cipherBytes, 1, 0, uint16be(extBytes.length), extBytes));
}
const uint64be = seq => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, seq, false); return b; };
const xorSequenceIntoIv = (iv, seq) => {
	const nonce = iv.slice(), sb = uint64be(seq);
	for (let i = 0; i < 8; i++) nonce[nonce.length - 8 + i] ^= sb[i];
	return nonce;
};
const deriveTrafficKeys = (hash, secret, keyLen, ivLen) => Promise.all([
	hkdfExpandLabel(hash, secret, "key", EMPTY_BYTES, keyLen),
	hkdfExpandLabel(hash, secret, "iv", EMPTY_BYTES, ivLen)
]);

export class TlsClient {
	constructor(socket, options = {}) {
		this.socket = socket; this.serverName = options.serverName || ""; this.timeout = options.timeout ?? 15000;
		this.clientRandom = randomBytes(32); this.handshakeChunks = []; this.handshakeComplete = false;
		this.recordParser = new TlsRecordParser(); this.handshakeParser = new TlsHandshakeParser();
		this.clientSeqNum = 0n; this.serverSeqNum = 0n;
	}
	recordHandshake(c) { this.handshakeChunks.push(c); }
	transcript() { return concatBytes(...this.handshakeChunks); }
	async readChunk(reader) {
		return Promise.race([reader.read(), new Promise((_, rej) => setTimeout(() => rej(new Error("TLS 读取超时")), this.timeout))]);
	}
	async readRecordsUntil(reader, predicate, closedError) {
		for (;;) {
			let rec;
			while ((rec = this.recordParser.next())) if (await predicate(rec)) return;
			const { value, done } = await this.readChunk(reader);
			if (done) throw new Error(closedError);
			this.recordParser.feed(value);
		}
	}
	async handshake() {
		const [p256Share, x25519Share] = await Promise.all([generateKeyShare("P-256"), generateKeyShare("X25519")]);
		this.keyPairs = new Map([[23, p256Share], [29, x25519Share]]); this.ecdhKeyPair = p256Share.keyPair;
		const reader = this.socket.readable.getReader(), writer = this.socket.writable.getWriter();
		try {
			const ch = buildClientHello(this.clientRandom, this.serverName, { x25519: x25519Share.publicKeyRaw, p256: p256Share.publicKeyRaw });
			this.recordHandshake(ch); await writer.write(buildTlsRecord(CONTENT_TYPE_HANDSHAKE, ch, TLS_VERSION_10));
			const sh = await this.receiveServerHello(reader);
			if (sh.keyShare?.group && this.keyPairs.has(sh.keyShare.group)) this.ecdhKeyPair = this.keyPairs.get(sh.keyShare.group).keyPair;
			sh.isTls13 ? await this.handshakeTls13(reader, writer, sh) : await this.handshakeTls12(reader, writer);
			this.handshakeComplete = true;
		} finally {
			try { reader.releaseLock(); } catch (e) {} try { writer.releaseLock(); } catch (e) {}
		}
	}
	async receiveServerHello(reader) {
		for (;;) {
			const { value, done } = await this.readChunk(reader);
			if (done) throw new Error("等待 ServerHello 时连接关闭");
			this.recordParser.feed(value); let rec;
			while ((rec = this.recordParser.next())) {
				if (rec.type === CONTENT_TYPE_ALERT) {
					if (shouldIgnoreTlsAlert(rec.fragment)) continue;
					throw new Error(`TLS Alert: ${rec.fragment[1]}`);
				}
				if (rec.type !== CONTENT_TYPE_HANDSHAKE) continue;
				this.handshakeParser.feed(rec.fragment); let msg;
				while ((msg = this.handshakeParser.next())) {
					if (msg.type !== HANDSHAKE_TYPE_SERVER_HELLO) continue;
					this.recordHandshake(msg.raw);
					const sh = parseServerHello(msg.body);
					this.serverRandom = sh.serverRandom; this.cipherSuite = sh.cipherSuite; this.cipherConfig = CIPHER_SUITES_BY_ID.get(sh.cipherSuite); this.isTls13 = sh.isTls13;
					if (!this.cipherConfig) throw new Error(`不支持的加密套件: 0x${sh.cipherSuite.toString(16)}`);
					return sh;
				}
			}
		}
	}
	async handshakeTls12(reader, writer) {
		let ske = null, certReq = false;
		await this.readRecordsUntil(reader, async rec => {
			if (rec.type !== CONTENT_TYPE_HANDSHAKE) return;
			this.handshakeParser.feed(rec.fragment); let msg;
			while ((msg = this.handshakeParser.next())) {
				this.recordHandshake(msg.raw);
				if (msg.type === HANDSHAKE_TYPE_SERVER_KEY_EXCHANGE) ske = parseServerKeyExchange(msg.body);
				else if (msg.type === HANDSHAKE_TYPE_CERTIFICATE_REQUEST) certReq = true;
				else if (msg.type === HANDSHAKE_TYPE_SERVER_HELLO_DONE) return true;
			}
		}, "TLS 1.2 握手中断");
		const curveName = GROUPS_BY_ID.get(ske.namedCurve), ks = this.keyPairs.get(ske.namedCurve);
		const pms = await deriveSharedSecret(ks.keyPair.privateKey, ske.serverPublicKey, curveName);
		const cke = buildHandshakeMessage(HANDSHAKE_TYPE_CLIENT_KEY_EXCHANGE, tlsBytes(ks.publicKeyRaw.length, ks.publicKeyRaw));
		if (certReq) {
			const emptyCert = buildHandshakeMessage(HANDSHAKE_TYPE_CERTIFICATE, tlsBytes(0, 0, 0));
			this.recordHandshake(emptyCert); await writer.write(buildTlsRecord(CONTENT_TYPE_HANDSHAKE, emptyCert));
		}
		this.recordHandshake(cke);
		const hash = this.cipherConfig.hash, kl = this.cipherConfig.keyLen, ivl = this.cipherConfig.ivLen;
		this.masterSecret = await tls12Prf(pms, "master secret", concatBytes(this.clientRandom, this.serverRandom), 48, hash);
		const kb = await tls12Prf(this.masterSecret, "key expansion", concatBytes(this.serverRandom, this.clientRandom), 2 * kl + 2 * ivl, hash);
		this.clientWriteKey = kb.slice(0, kl); this.serverWriteKey = kb.slice(kl, 2 * kl);
		this.clientWriteIv = kb.slice(2 * kl, 2 * kl + ivl); this.serverWriteIv = kb.slice(2 * kl + ivl, 2 * kl + 2 * ivl);
		if (!this.cipherConfig.chacha) {
			[this.clientWriteCryptoKey, this.serverWriteCryptoKey] = await Promise.all([importAesGcmKey(this.clientWriteKey, ["encrypt"]), importAesGcmKey(this.serverWriteKey, ["decrypt"])]);
		}
		await writer.write(buildTlsRecord(CONTENT_TYPE_HANDSHAKE, cke)); await writer.write(buildTlsRecord(CONTENT_TYPE_CHANGE_CIPHER_SPEC, tlsBytes(1)));
		const cvd = await tls12Prf(this.masterSecret, "client finished", await digestBytes(hash, this.transcript()), 12, hash);
		const fin = buildHandshakeMessage(HANDSHAKE_TYPE_FINISHED, cvd);
		this.recordHandshake(fin); await writer.write(buildTlsRecord(CONTENT_TYPE_HANDSHAKE, await this.encryptTls12(fin, CONTENT_TYPE_HANDSHAKE)));
		let sawCCS = false;
		await this.readRecordsUntil(reader, async rec => {
			if (rec.type === CONTENT_TYPE_CHANGE_CIPHER_SPEC) { sawCCS = true; return; }
			if (rec.type === CONTENT_TYPE_HANDSHAKE && sawCCS) { const dec = await this.decryptTls12(rec.fragment, CONTENT_TYPE_HANDSHAKE); if (dec[0] === HANDSHAKE_TYPE_FINISHED) return true; }
		}, "TLS 1.2 Finished 超时");
	}
	async handshakeTls13(reader, writer, sh) {
		const groupName = GROUPS_BY_ID.get(sh.keyShare?.group);
		const hash = this.cipherConfig.hash, hl = hashByteLength(hash), kl = this.cipherConfig.keyLen, ivl = this.cipherConfig.ivLen;
		const shared = await deriveSharedSecret(this.ecdhKeyPair.privateKey, sh.keyShare.key, groupName);
		const early = await hkdfExtract(hash, null, new Uint8Array(hl));
		const derived = await hkdfExpandLabel(hash, early, "derived", await digestBytes(hash, EMPTY_BYTES), hl);
		this.handshakeSecret = await hkdfExtract(hash, derived, shared);
		const th = await digestBytes(hash, this.transcript());
		const cHs = await hkdfExpandLabel(hash, this.handshakeSecret, "c hs traffic", th, hl);
		const sHs = await hkdfExpandLabel(hash, this.handshakeSecret, "s hs traffic", th, hl);
		[this.clientHandshakeKey, this.clientHandshakeIv] = await deriveTrafficKeys(hash, cHs, kl, ivl);
		[this.serverHandshakeKey, this.serverHandshakeIv] = await deriveTrafficKeys(hash, sHs, kl, ivl);
		if (!this.cipherConfig.chacha) {
			[this.clientHandshakeCryptoKey, this.serverHandshakeCryptoKey] = await Promise.all([importAesGcmKey(this.clientHandshakeKey, ["encrypt"]), importAesGcmKey(this.serverHandshakeKey, ["decrypt"])]);
		}
		let sFin = false, certReq = false;
		await this.readRecordsUntil(reader, async rec => {
			if (rec.type !== CONTENT_TYPE_APPLICATION_DATA) return;
			const dec = await this.decryptTls13Handshake(rec.fragment);
			if (dec[dec.length - 1] === CONTENT_TYPE_HANDSHAKE) {
				this.handshakeParser.feed(dec.slice(0, -1)); let msg;
				while ((msg = this.handshakeParser.next())) {
					this.recordHandshake(msg.raw);
					if (msg.type === HANDSHAKE_TYPE_CERTIFICATE_REQUEST) certReq = true;
					else if (msg.type === HANDSHAKE_TYPE_FINISHED) { sFin = true; return true; }
				}
			}
		}, "TLS 1.3 握手中断");
		const appTh = await digestBytes(hash, this.transcript());
		const mDerived = await hkdfExpandLabel(hash, this.handshakeSecret, "derived", await digestBytes(hash, EMPTY_BYTES), hl);
		const master = await hkdfExtract(hash, mDerived, new Uint8Array(hl));
		const cApp = await hkdfExpandLabel(hash, master, "c ap traffic", appTh, hl);
		const sApp = await hkdfExpandLabel(hash, master, "s ap traffic", appTh, hl);
		[this.clientAppKey, this.clientAppIv] = await deriveTrafficKeys(hash, cApp, kl, ivl);
		[this.serverAppKey, this.serverAppIv] = await deriveTrafficKeys(hash, sApp, kl, ivl);
		if (!this.cipherConfig.chacha) {
			[this.clientAppCryptoKey, this.serverAppCryptoKey] = await Promise.all([importAesGcmKey(this.clientAppKey, ["encrypt"]), importAesGcmKey(this.serverAppKey, ["decrypt"])]);
		}
		let cFlight = EMPTY_BYTES;
		if (certReq) { cFlight = buildHandshakeMessage(HANDSHAKE_TYPE_CERTIFICATE, tlsBytes(0, 0, 0, 0)); this.recordHandshake(cFlight); }
		const cFinKey = await hkdfExpandLabel(hash, cHs, "finished", EMPTY_BYTES, hl);
		const cFinVd = await hmac(hash, cFinKey, await digestBytes(hash, this.transcript()));
		const cFinMsg = buildHandshakeMessage(HANDSHAKE_TYPE_FINISHED, cFinVd);
		this.recordHandshake(cFinMsg);
		await writer.write(buildTlsRecord(CONTENT_TYPE_APPLICATION_DATA, await this.encryptTls13Handshake(concatBytes(cFlight, cFinMsg, [CONTENT_TYPE_HANDSHAKE]))));
		this.clientSeqNum = 0n; this.serverSeqNum = 0n;
	}
	async encryptTls12(pt, type) {
		const seq = this.clientSeqNum++, aad = concatBytes(uint64be(seq), [type], uint16be(TLS_VERSION_12), uint16be(pt.length));
		if (this.cipherConfig.chacha) return chacha20Poly1305Encrypt(this.clientWriteKey, xorSequenceIntoIv(this.clientWriteIv, seq), pt, aad);
		const en = randomBytes(8);
		return concatBytes(en, await aesGcmEncryptWithKey(this.clientWriteCryptoKey, concatBytes(this.clientWriteIv, en), pt, aad));
	}
	async decryptTls12(ct, type) {
		const seq = this.serverSeqNum++;
		if (this.cipherConfig.chacha) return chacha20Poly1305Decrypt(this.serverWriteKey, xorSequenceIntoIv(this.serverWriteIv, seq), ct, concatBytes(uint64be(seq), [type], uint16be(TLS_VERSION_12), uint16be(ct.length - 16)));
		const en = ct.subarray(0, 8), enc = ct.subarray(8);
		return aesGcmDecryptWithKey(this.serverWriteCryptoKey, concatBytes(this.serverWriteIv, en), enc, concatBytes(uint64be(seq), [type], uint16be(TLS_VERSION_12), uint16be(enc.length - 16)));
	}
	async encryptTls13Handshake(pt) {
		const nonce = xorSequenceIntoIv(this.clientHandshakeIv, this.clientSeqNum++), aad = tlsBytes(CONTENT_TYPE_APPLICATION_DATA, 3, 3, uint16be(pt.length + 16));
		return this.cipherConfig.chacha ? chacha20Poly1305Encrypt(this.clientHandshakeKey, nonce, pt, aad) : aesGcmEncryptWithKey(this.clientHandshakeCryptoKey, nonce, pt, aad);
	}
	async decryptTls13Handshake(ct) {
		const nonce = xorSequenceIntoIv(this.serverHandshakeIv, this.serverSeqNum++), aad = tlsBytes(CONTENT_TYPE_APPLICATION_DATA, 3, 3, uint16be(ct.length));
		const dec = this.cipherConfig.chacha ? await chacha20Poly1305Decrypt(this.serverHandshakeKey, nonce, ct, aad) : await aesGcmDecryptWithKey(this.serverHandshakeCryptoKey, nonce, ct, aad);
		let idx = dec.length - 1; while (idx >= 0 && !dec[idx]) idx--;
		return idx < 0 ? EMPTY_BYTES : dec.slice(0, idx + 1);
	}
	async encryptTls13(data) {
		const pt = concatBytes(data, [CONTENT_TYPE_APPLICATION_DATA]), nonce = xorSequenceIntoIv(this.clientAppIv, this.clientSeqNum++), aad = tlsBytes(CONTENT_TYPE_APPLICATION_DATA, 3, 3, uint16be(pt.length + 16));
		return this.cipherConfig.chacha ? chacha20Poly1305Encrypt(this.clientAppKey, nonce, pt, aad) : aesGcmEncryptWithKey(this.clientAppCryptoKey, nonce, pt, aad);
	}
	async decryptTls13(ct) {
		const nonce = xorSequenceIntoIv(this.serverAppIv, this.serverSeqNum++), aad = tlsBytes(CONTENT_TYPE_APPLICATION_DATA, 3, 3, uint16be(ct.length));
		const pt = this.cipherConfig.chacha ? await chacha20Poly1305Decrypt(this.serverAppKey, nonce, ct, aad) : await aesGcmDecryptWithKey(this.serverAppCryptoKey, nonce, ct, aad);
		let idx = pt.length - 1; while (idx >= 0 && !pt[idx]) idx--;
		return idx < 0 ? { data: EMPTY_BYTES, type: 0 } : { data: pt.slice(0, idx), type: pt[idx] };
	}
	async write(data) {
		const pt = 数据转Uint8Array(data);
		if (!pt.byteLength) return;
		const writer = this.socket.writable.getWriter();
		try {
			const records = [];
			for (let off = 0; off < pt.byteLength; off += TLS_MAX_PLAINTEXT_FRAGMENT) {
				const chunk = pt.subarray(off, Math.min(off + TLS_MAX_PLAINTEXT_FRAGMENT, pt.byteLength));
				const enc = this.isTls13 ? await this.encryptTls13(chunk) : await this.encryptTls12(chunk, CONTENT_TYPE_APPLICATION_DATA);
				records.push(buildTlsRecord(CONTENT_TYPE_APPLICATION_DATA, enc));
			}
			await writer.write(records.length === 1 ? records[0] : concatBytes(...records));
		} finally {
			try { writer.releaseLock(); } catch (e) {}
		}
	}
	async read() {
		for (;;) {
			let rec;
			while ((rec = this.recordParser.next())) {
				if (rec.type === CONTENT_TYPE_ALERT) {
					if (rec.fragment[1] === ALERT_CLOSE_NOTIFY) return null;
					throw new Error(`TLS Alert: ${rec.fragment[1]}`);
				}
				if (rec.type !== CONTENT_TYPE_APPLICATION_DATA) continue;
				if (!this.isTls13) return this.decryptTls12(rec.fragment, CONTENT_TYPE_APPLICATION_DATA);
				const { data, type } = await this.decryptTls13(rec.fragment);
				if (type === CONTENT_TYPE_APPLICATION_DATA) return data;
				if (type === CONTENT_TYPE_ALERT && data[1] === ALERT_CLOSE_NOTIFY) return null;
			}
			const reader = this.socket.readable.getReader();
			try {
				const { value, done } = await this.readChunk(reader);
				if (done) return null;
				this.recordParser.feed(value);
			} finally {
				try { reader.releaseLock(); } catch (e) {}
			}
		}
	}
	close() { try { this.socket.close(); } catch (e) {} }
}