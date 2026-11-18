const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};
const json = (data, status=200) => new Response(JSON.stringify(data), {
  status, headers: { "Content-Type":"application/json; charset=utf-8", ...cors }
});
async function searchWeb(query) {
  const url = "https://api.duckduckgo.com/?q="+encodeURIComponent(query)+"&format=json&no_html=1&skip_disambig=1";
  try {
    const r = await fetch(url, {headers:{"Accept":"application/json"}});
    if (!r.ok) return {text:"", sources:[]};
    const d = await r.json(), rows=[], sources=[];
    if(d.AbstractText) rows.push(d.AbstractText);
    for(const x of (d.RelatedTopics||[]).slice(0,5)){
      if(x.Text) rows.push(x.Text);
      else if(x.Topics) for(const y of x.Topics.slice(0,2)) if(y.Text) rows.push(y.Text);
    }
    if(d.AbstractURL) sources.push({title:d.Heading||"DuckDuckGo",url:d.AbstractURL});
    return {text:rows.join("\n"),sources};
  } catch { return {text:"",sources:[]}; }
}
const system = "Ты ULTRA AI BRAIN — полезный русскоязычный ИИ-помощник. Всегда отвечай на русском языке. Будь точным, честно указывай неопределённость. Не выдумывай источники. Если дан контекст веб-поиска, используй его осторожно и отмечай, если данных недостаточно.";
async function callCloudflare(env, prompt, deep) {
  if(!env.AI) return null;
  const model=env.AI_MODEL || "@cf/meta/llama-3.1-8b-instruct";
  const r=await env.AI.run(model,{messages:[{role:"system",content:system},{role:"user",content:prompt}],max_tokens:deep?1800:1100,temperature:0.6});
  return {name:"Cloudflare Workers AI",model,text:r.response||r.result?.response||""};
}
async function callGemini(env,prompt,deep) {
  if(!env.GEMINI_API_KEY) return null;
  const model=env.GEMINI_MODEL||"gemini-2.5-flash";
  const url=`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`;
  const r=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({systemInstruction:{parts:[{text:system}]},contents:[{role:"user",parts:[{text:prompt}]}],generationConfig:{maxOutputTokens:deep?1800:1100,temperature:0.6}})});
  if(!r.ok) throw new Error("Gemini: HTTP "+r.status);
  const d=await r.json();
  return {name:"Google Gemini",model,text:(d.candidates?.[0]?.content?.parts||[]).map(x=>x.text||"").join("\n")};
}
async function callGroq(env,prompt,deep) {
  if(!env.GROQ_API_KEY) return null;
  const model=env.GROQ_MODEL||"llama-3.3-70b-versatile";
  const r=await fetch("https://api.groq.com/openai/v1/chat/completions",{method:"POST",headers:{"Authorization":"Bearer "+env.GROQ_API_KEY,"Content-Type":"application/json"},body:JSON.stringify({model,messages:[{role:"system",content:system},{role:"user",content:prompt}],max_tokens:deep?1800:1100,temperature:0.6})});
  if(!r.ok) throw new Error("Groq: HTTP "+r.status);
  const d=await r.json();
  return {name:"Groq",model,text:d.choices?.[0]?.message?.content||""};
}
export async function onRequestOptions(){return new Response(null,{headers:cors});}
export async function onRequestPost({request,env}) {
  try {
    const body=await request.json(), message=String(body.message||"").trim().slice(0,6000);
    if(!message) return json({error:"Напиши вопрос."},400);
    let web={text:"",sources:[]};
    if(body.web) web=await searchWeb(message);
    const prompt=(body.deep?"Дай структурированный, подробный ответ с проверкой допущений.\n\n":"")+message+(web.text?"\n\nКонтекст веб-поиска (может быть неполным):\n"+web.text:"");
    const tasks=[callCloudflare(env,prompt,!!body.deep),callGemini(env,prompt,!!body.deep),callGroq(env,prompt,!!body.deep)];
    const settled=await Promise.allSettled(tasks), answers=settled.filter(x=>x.status==="fulfilled"&&x.value?.text);
    if(!answers.length) {
      const errors=settled.filter(x=>x.status==="rejected").map(x=>String(x.reason?.message||"ошибка")).join("; ");
      return json({error:"Не подключена ни одна рабочая модель. Добавь Cloudflare Workers AI binding AI или бесплатные ключи GEMINI_API_KEY / GROQ_API_KEY в переменные окружения. "+errors,sources:web.sources},503);
    }
    let finalText, provider;
    if(answers.length===1){finalText=answers[0].value.text;provider=answers[0].value.name+" · "+answers[0].value.model;}
    else {
      const board=answers.map((a,i)=>`ОТВЕТ ${i+1} (${a.value.name}):\n${a.value.text}`).join("\n\n---\n\n");
      const synthesisPrompt="Ниже представлены независимые ответы нескольких ИИ на один вопрос. Сравни их, убери ошибки и повторы, отметь разногласия и составь один наиболее точный, полезный итоговый ответ на русском. Не утверждай, что факт проверен, если источники этого не подтверждают.\n\n"+board+"\n\nИсходный вопрос: "+message;
      let synthesis=null;
      for(const fn of [()=>callCloudflare(env,synthesisPrompt,!!body.deep),()=>callGemini(env,synthesisPrompt,!!body.deep),()=>callGroq(env,synthesisPrompt,!!body.deep)]) {
        try { synthesis=await fn(); if(synthesis?.text) break; } catch {}
      }
      finalText=synthesis?.text||board;
      provider="Совет "+answers.length+" ИИ · "+answers.map(a=>a.value.name).join(" + ");
    }
    return json({answer:finalText,provider,sources:web.sources,notice:"Количество доступных ИИ зависит от подключённых бесплатных тарифов и их квот. Сравнение моделей не гарантирует безошибочность."});
  } catch(e) { return json({error:"Внутренняя ошибка: "+String(e.message||e)},500); }
}