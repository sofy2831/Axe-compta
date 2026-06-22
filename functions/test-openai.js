const fetch = require("node-fetch");

async function test() {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
     "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
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
