const fetch = require("node-fetch");

async function test() {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer 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`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      input: "Dis moi si 2+2=4 en une phrase"
    })
  });

  const data = await res.json();
  console.log(JSON.stringify(data, null, 2));
}

test();
