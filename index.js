import { readFileSync, promises } from "fs";
import {
  getUserInfo,
  getDir,
  logIntro,
  sleep,
  logWork,
  decrypt,
} from "./utils/index.js";
import consoleStamp from "console-stamp";
import {
  createPublicClient,
  http,
  getContract,
  createWalletClient,
  encodeFunctionData,
  webSocket,
  parseGwei,
  decodeFunctionData,
  formatEther,
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import axios from "axios";
import chalk from "chalk";
import pkg from "lodash";
import readlineSync from "readline-sync";
import { couldBeSold, getMaxPrice } from "./strategy/index.js";
import {
  BuyStrategy,
  couldBeBought,
  isWhitelisted,
  shouldBuy,
  shouldFetchPrice,
  shouldFetchTwitterInfo,
} from "./strategy/buy.js";
import { shouldSell } from "./strategy/sell.js";

const { throttle } = pkg;

const wallets = JSON.parse(readFileSync(getDir("wallets.json"), "utf8"));
const bots = JSON.parse(readFileSync(getDir("bots.json"), "utf8"));
const abi = JSON.parse(readFileSync(getDir("abi.json"), "utf-8"));
const contractAddress = "0xcf205808ed36593aa40a44f10c7f7c2f67d4a4d4";
const publicClient = createPublicClient({
  chain: base,
  transport: http(
    "https://base-mainnet.blastapi.io/fe9c30fc-3bc5-4064-91e2-6ab5887f8f4d"
  ),
});
const contract = getContract({
  address: contractAddress,
  abi: abi,
  // @ts-ignore
  publicClient: publicClient,
});
const websocketClient = createPublicClient({
  chain: base,
  transport: webSocket(
    "wss://base-mainnet.blastapi.io/fe9c30fc-3bc5-4064-91e2-6ab5887f8f4d"
  ),
});
const BASE_SCAN_API = "GWV3I6MRRIIDB1RA4UAIYAYGJ4KCGRR5ME";

const main = async (wallet) => {
  const client = createWalletClient({
    account: privateKeyToAccount(`0x${wallet.pk}`),
    chain: base,
    transport: http(),
  });

  const gasLimit = "100000";
  const maxBuyPrice = getMaxPrice();

  let holdings = [];
  let nonce = 56;
  let ETH_USCT_Rate = 1600;
  let unwatch;
  let buying = false;
  let lastActivity;
  let intervalId;
  let selling = false;
  let twitterInfoMap = {};

  const buyShare = async (value, subjectAddress, amount = 1) => {
    if (buying) return;
    buying = true;
    const data = encodeFunctionData({
      abi: abi,
      functionName: "buyShares",
      args: [subjectAddress, amount],
    });
    const txParams = {
      value: value,
      data: data,
      to: contractAddress,
      gasPrice: parseGwei("0.3"),
      gasLimit,
      nonce: nonce++,
    };
    try {
      const hash = await client.sendTransaction(txParams);
      console.log(`Sent tx > ${hash}`);
      const transaction = await publicClient.waitForTransactionReceipt({
        confirmations: 2,
        hash,
      });

      console.log(
        chalk[transaction.status === "success" ? "green" : "red"](
          `Buy ${subjectAddress} ${transaction.status}`
        )
      );
      buying = false;
      if (transaction.status === "success") {
        await refreshHoldings();
      }
    } catch (error) {
      buying = false;
      console.log("error", error.shortMessage);
    }
  };

  const watchContractTradeEvent = async () => {
    await freshNonce();
    if (unwatch) {
      unwatch();
    }
    unwatch = websocketClient.watchContractEvent({
      address: contractAddress,
      abi: abi,
      eventName: "Trade",
      onLogs: throttle(
        async (logs) => {
          await checkIfBuy(logs);
        },
        process.env.useTwitterAPI ? 0 : 5000
      ),
    });
  };

  const getBuyPrice = async (subjectAddress, amount = 1) => {
    console.log(chalk.gray("get buy price...", subjectAddress));
    try {
      const price = await contract.read.getBuyPriceAfterFee({
        args: [subjectAddress, amount],
      });
      return price > 0 ? price : await getBuyPrice(subjectAddress, amount);
    } catch (error) {
      console.log("get buy price failed", error.message);
      return await getBuyPrice(subjectAddress, amount);
    }
  };

  const checkIfBuy = async (logs) => {
    if (buying) return;
    if (logs instanceof Array && logs.length > 0) {
      try {
        const filterLogs = logs.filter((log) => {
          if (log.args.ethAmount === BigInt(0)) {
            console.log(chalk.yellow("new User", log.args.subject));
          }

          return (
            parseFloat(formatEther(log.args.ethAmount)) < maxBuyPrice &&
            couldBeBought(log.args, bots, holdings)
          );
        });
        for (const log of filterLogs) {
          const start = Date.now();
          const keyInfo = await fetchProfile(log.args.subject);
          if (!keyInfo.username) {
            continue;
          }
          const ethAmount = log.args.ethAmount;
          const previousETHPrice = parseFloat(formatEther(ethAmount));
          keyInfo.price = previousETHPrice;
          const twitterInfo = {};
          const accountInfo = {};

          const whitelistedUser = isWhitelisted(keyInfo);
          // if not whitelisted
          if (!whitelistedUser) {
            // if has twiiter conditions and other conditions all met
            if (shouldFetchTwitterInfo(accountInfo, keyInfo)) {
              let info;
              if (twitterInfoMap[keyInfo.username]) {
                info = twitterInfoMap[keyInfo.username];
              } else {
                info = twitterInfoMap[keyInfo.username] = await getUserInfo(
                  keyInfo.username
                );
              }
              if (BuyStrategy.onlyBuyBlueVerified && !info.isBlueVerified) {
                continue;
              }
              twitterInfo.viewAvg = info.viewAvg;
              twitterInfo.favoriteAvg = info.favoriteAvg;
              twitterInfo.followers = info.followers_count;
              twitterInfo.posts = info.statuses_count;
              console.log(
                chalk.blue(
                  JSON.stringify({
                    ...accountInfo,
                    ...twitterInfo,
                    ...keyInfo,
                    duration: `${(Date.now() - start) / 1000}s`,
                  })
                )
              );
            }
          }
          if (shouldFetchPrice(accountInfo, twitterInfo, keyInfo)) {
            const price = await getBuyPrice(
              keyInfo.subject,
              whitelistedUser?.buyAmount
            );
            const ethPrice = parseFloat(formatEther(price));
            keyInfo.price = ethPrice; // 以最新的价格去跑策略,看下能否通过所有条件
            if (shouldBuy(accountInfo, twitterInfo, keyInfo)) {
              logWork({
                walletAddress: wallet.address,
                actionName: "buy",
                subject: `${keyInfo.subject} - ${keyInfo.username}`,
                price: ethPrice.toString(),
              });
              await buyShare(
                price,
                keyInfo.subject,
                whitelistedUser?.buyAmount
              );
            }
          }
        }
      } catch (error) {
        console.error("Error during buying process:", error);
      }
    }
  };

  const fetchProfile = async (subject, count = 0) => {
    try {
      const res = await axios.get(
        `https://prod-api.kosetto.com/users/${subject}`,
        {
          timeout: 3000,
        }
      );
      if (res.data?.id) {
        const username = res.data?.twitterUsername;
        if (!username) {
          console.log(
            chalk.yellow(
              subject,
              "无法在 friend 获取到信息，疑似幽灵账号，跳过..."
            )
          );
          return {};
        }
        return {
          subject: subject,
          username,
        };
      } else {
        if (count < 2) {
          await sleep(1);
          return await fetchProfile(subject, count + 1);
        } else {
          console.log(
            chalk.yellow(
              subject,
              "无法在 friend 获取到信息，疑似幽灵账号，跳过..."
            )
          );
          return {};
        }
      }
    } catch (error) {
      if (error.message.includes("404") && count < 2) {
        await sleep(1);
        return await fetchProfile(subject, count + 1);
      }
      return {};
    }
  };

  const freshNonce = async () => {
    // 顺便把占用内存的变量释放掉
    twitterInfoMap = {};
    try {
      console.log("刷新 nonce...");
      const transactionCount = await publicClient.getTransactionCount({
        address: wallet.address,
      });
      nonce = transactionCount;
    } catch (error) {
      await sleep(2);
      await freshNonce();
    }
  };

  const refreshHoldings = async () => {
    await freshNonce();
    try {
      const res = await axios({
        method: "get",
        url: `https://prod-api.kosetto.com/portfolio/${wallet.address}`,
        headers: {
          Host: "prod-api.kosetto.com",
          "sec-ch-ua":
            '"Chromium";v="112", "Google Chrome";v="112", "Not:A-Brand";v="99"',
          accept: "application/json",
          "sec-ch-ua-platform": '"Android"',
          "sec-ch-ua-mobile": "?1",
          authorization: wallet.authorization,
          "user-agent":
            "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36",
          "content-type": "application/json",
          origin: "https://www.friend.tech",
          "sec-fetch-site": "cross-site",
          "sec-fetch-mode": "cors",
          "sec-fetch-dest": "empty",
          referer: "https://www.friend.tech/",
          "accept-language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
          "if-none-match": wallet.ifNoneMatch,
          timeout: 3000,
        },
      });
      if (res.data?.holdings?.length) {
        await mergeCosts(res.data?.holdings);
      } else {
        holdings = [];
      }
    } catch (error) {
      console.log("refreshHoldings error", error.message);
      await sleep(3);
      await refreshHoldings();
    }
  };

  const hoursSinceCreatedAt = (timeStamp) => {
    const createdAt = parseInt(timeStamp, 10) * 1000;

    // 获取当前的 Unix 时间戳（毫秒）
    const now = Date.now();

    // 计算时间差（毫秒）
    const differenceInMilliseconds = now - createdAt;

    // 转换为小时并向下取整
    const differenceInHours = Math.floor(
      differenceInMilliseconds / (1000 * 60 * 60)
    );

    return differenceInHours;
  };

  const mergeCosts = async (arr) => {
    const transactions = await getTransactionHistory();
    const subjectMap = {};
    arr.forEach((item) => {
      subjectMap[item.subject.toString().toLowerCase()] = item;
    });
    transactions.forEach((transaction) => {
      const { args } = decodeFunctionData({
        abi: abi,
        data: transaction.input,
      });
      const subject = args[0].toString().toLowerCase();
      if (subjectMap[subject]) {
        if (subjectMap[subject].cost) {
          // 如果 balance 只有 1，交易记录买过 2 次，卖出 1 次，只记录一次成本
          if (subjectMap[subject].counter < subjectMap[subject].balance) {
            subjectMap[subject].counter += 1;
            subjectMap[subject].cost =
              BigInt(subjectMap[subject].cost) +
              BigInt(calculateTransactionCost(transaction));
          }
        } else {
          subjectMap[subject].counter = 1;
          subjectMap[subject].cost = calculateTransactionCost(transaction);
        }

        subjectMap[subject].holdingDuration = hoursSinceCreatedAt(
          transaction.timeStamp
        );
      }
    });
    holdings = arr.filter((item) => {
      return item.cost;
    });
    console.log("holdings", holdings.length);
  };

  const calculateTransactionCost = (transaction) => {
    const gasUsed = BigInt(transaction.gasUsed);
    const gasPrice = BigInt(transaction.gasPrice);
    const value = BigInt(transaction.value);

    // 计算总成本
    const totalCost = gasUsed * gasPrice * BigInt(2) + value;

    return totalCost.toString();
  };

  const getBridgedAmount = async (subject) => {
    try {
      const res = await axios.get(
        `https://api.basescan.org/api?module=account&action=txlist&address=${subject}&startblock=0&endblock=99999999&sort=asc&apikey=${BASE_SCAN_API}`,
        {
          timeout: 3000,
        }
      );
      const incomeTxs = res.data.result.filter(
        (f) => f.to.toLowerCase() === subject.toLowerCase()
      );
      const incomeTxsSum = incomeTxs.reduce((acc, cur) => {
        return acc + parseFloat(formatEther(BigInt(cur.value)));
      }, 0);
      return incomeTxsSum;
      return 0;
    } catch (error) {
      await sleep(5);
      return await getBridgedAmount();
    }
  };

  const getTransactionHistory = async () => {
    try {
      const transactions = await axios.get(
        `https://api.basescan.org/api?module=account&action=txlist&address=${wallet.address}&startblock=0&endblock=99999999&sort=desc&apikey=${BASE_SCAN_API}`,
        {
          timeout: 3000,
        }
      );
      const succeedTransactions = (transactions?.data?.result || [])?.filter(
        (transaction) => {
          return (
            transaction.isError === "0" &&
            transaction.to === contractAddress &&
            // 只筛选出买入的交易
            transaction.methodId === "0x6945b123"
          );
        }
      );
      return succeedTransactions || [];
    } catch (error) {
      await sleep(5);
      return await getTransactionHistory();
    }
  };

  const watchHoldingsActivity = async () => {
    console.log(chalk.gray("check holdings activity..."));
    try {
      const res = await axios({
        method: "get",
        url: `https://prod-api.kosetto.com/holdings-activity/${wallet.address}`,
        headers: {
          Host: "prod-api.kosetto.com",
          "sec-ch-ua":
            '"Chromium";v="112", "Google Chrome";v="112", "Not:A-Brand";v="99"',
          accept: "application/json",
          "sec-ch-ua-platform": '"Android"',
          "sec-ch-ua-mobile": "?1",
          authorization: wallet.authorization,
          "user-agent":
            "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36",
          "content-type": "application/json",
          origin: "https://www.friend.tech",
          "sec-fetch-site": "cross-site",
          "sec-fetch-mode": "cors",
          "sec-fetch-dest": "empty",
          referer: "https://www.friend.tech/",
          "accept-language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
          "if-none-match": wallet.ifNoneMatch,
        },
        timeout: 1000 * 5,
      });
      // console.log(chalk.blue("res.data?.events", res.data?.events.length));
      if (res.data?.events?.length) {
        if (!lastActivity) {
          lastActivity = res.data.events[0];
          if (
            lastActivity.isBuy &&
            lastActivity.trader.address.toLowerCase() !==
              wallet.address.toLowerCase()
          ) {
            console.warn(chalk.green("try execute sell..."));
            await refreshHoldings();
            await checkIfSell();
          }
        } else {
          const index = res.data.events.findIndex(
            (item) =>
              item.subject.address === lastActivity.subject.address &&
              item.createAt === lastActivity.createAt &&
              item.trader.address === lastActivity.trader.address
          );
          if (index > -1) {
            const newEvents = res.data.events.slice(0, index);
            const newBuyEvents = newEvents.filter(
              (item) =>
                item.isBuy &&
                item.trader.address.toLowerCase() !==
                  wallet.address.toLowerCase()
            );
            console.log(
              chalk.yellow(`there are ${newBuyEvents.length} new buy events`)
            );
            if (newBuyEvents.length) {
              console.warn(chalk.green("try execute sell..."));
              await refreshHoldings();
              await checkIfSell();
            }
            lastActivity = res.data.events[0];
          } else {
            lastActivity = res.data.events[0];
            console.warn(chalk.green("try execute sell..."));
            await refreshHoldings();
            await checkIfSell();
          }
        }
      }
    } catch (error) {
      console.log("fetch holdings activity error");
    }
    await watchContractTradeEvent();
  };

  const getSellPrice = async (subjectAddress, amount = 1) => {
    try {
      const price = await contract.read.getSellPriceAfterFee({
        args: [subjectAddress, amount],
      });
      return price;
    } catch (error) {
      console.log(error.message);
      return null;
    }
  };

  const checkIfOwn = async (subjectAddress) => {
    try {
      const balance = await contract.read.sharesBalance({
        args: [subjectAddress, wallet.address],
      });
      if (balance > 0n) {
        return balance;
      } else {
        console.log("not own");
        return false;
      }
    } catch (error) {
      await sleep(3);
      return await checkIfOwn(subjectAddress);
    }
  };

  const sellShare = async (subjectAddress, own = 1) => {
    try {
      const data = encodeFunctionData({
        abi: abi,
        functionName: "sellShares",
        args: [subjectAddress, own],
      });
      const txParams = {
        value: 0,
        data: data,
        to: contractAddress,
        gasPrice: parseGwei("0.3"),
        gasLimit,
        nonce: nonce++,
      };
      const hash = await client.sendTransaction(txParams);
      console.log(`Sent tx > ${hash}`);
      const transaction = await publicClient.waitForTransactionReceipt({
        hash,
      });
      console.log(
        chalk[transaction.status === "success" ? "green" : "red"](
          `Sell ${subjectAddress} ${transaction.status}`
        )
      );
      if (transaction.status === "success") {
        return true;
      } else {
        return false;
      }
    } catch (error) {
      return false;
    }
  };

  const trySell = async (share, calculator) => {
    const price = await getSellPrice(share.subject, share.balance);
    if (!price) {
      return;
    }
    console.log(share.subject, share.name, "balance: ", share.balance);
    const ethPrice = parseFloat(formatEther(price).substring(0, 8)) * 0.9;
    const costEthPrice = parseFloat(formatEther(share.cost).substring(0, 8));
    const profit = parseFloat(
      ((ethPrice - costEthPrice) * ETH_USCT_Rate).toFixed(2)
    );
    console.log(
      chalk[profit > 0 ? "green" : "yellow"](
        `profit: ${profit} USDT, holding duration: ${share.holdingDuration} hours`
      )
    );
    const own = await checkIfOwn(share.subject);
    calculator.sum += profit;
    calculator.total += ethPrice;
    if (profit > 0) {
      calculator.positive += profit;
    } else {
      calculator.negative += profit;
    }
    if (!own) {
      return false;
    }
    if (
      ethPrice > 0 &&
      couldBeSold(wallet.address, share.subject) &&
      shouldSell(share.subject, profit, share.holdingDuration)
    ) {
      console.log("selling", share.subject, "price", ethPrice);
      const isSold = await sellShare(share.subject, own);
      if (isSold) {
        holdings = holdings.filter((item) => item.subject !== share.subject);
      }
      return isSold;
    } else {
      return false;
    }
  };

  const checkIfSell = async () => {
    await freshNonce();
    let unwatched = false;
    if (unwatch) {
      unwatch();
      unwatched = true;
    }
    while (buying) {
      await sleep(1);
    }
    const calculator = { sum: 0, positive: 0, negative: 0, total: 0 };
    for (let index = 0; index < holdings.length; index++) {
      selling = true;
      const share = holdings[index];
      const sold = await trySell(share, calculator);
      if (sold) {
        index = index - 1;
      }
    }
    selling = false;
    console.log(chalk.cyan(JSON.stringify(calculator)));
    // 如果去取消了购买轮询，要重新启用
    if (unwatched) {
      await watchContractTradeEvent();
    }
  };

  const execute = async () => {
    console.log(`已经将 ${bots.length} 个 bot 名单列入不购买名单`);
    if (intervalId !== undefined) {
      clearInterval(intervalId);
    }
    await refreshHoldings();
    await checkIfSell();
    await watchContractTradeEvent();

    intervalId = setInterval(async () => {
      if (!selling) {
        await watchHoldingsActivity();
      }
    }, 1000 * 60);
  };

  execute();
};

logIntro();
consoleStamp(console, {
  format: ":date(yyyy/mm/dd HH:MM:ss)",
});
const password1 = readlineSync.question("Password1: ", {
  hideEchoBack: true, // The typed text on screen is hidden by `*` (default).
});
const password2 = readlineSync.question("Password2: ", {
  hideEchoBack: true, // The typed text on screen is hidden by `*` (default).
});
process.env.pw1 = password1;
process.env.pw2 = password2;
if (password1 && password2) {
  for (let index = 0; index < wallets.length; index++) {
    const wallet = wallets[index];
    process.env.useTwitterAPI = wallet.useTwitterAPI;
    main({
      ...wallet,
      pk: decrypt(wallet.pk, password1, password2),
      authorization: decrypt(wallet.authorization, password1, password2),
    });
  }
}
