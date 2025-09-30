const express = require('express');
const { webcrack } = require('webcrack');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const t = require('@babel/types');
const crypto = require('crypto').webcrypto;

const app = express();
const PORT = 3000;

// 解析 JSON 请求体
app.use(express.json());

// 核心处理函数
async function processJsCode(jscode) {
  // 解码 base64
  const decodedCode = Buffer.from(jscode, 'base64').toString('utf-8');

  // 1. 使用 webcrack 进行反混淆
  const result = await webcrack(decodedCode);
  const deobfuscatedCode = result.code;

  // 2. 使用 @babel/parser 解析代码
  const ast = parser.parse(deobfuscatedCode, {
    sourceType: 'module',
    plugins: []
  });

  let extractedData = null;
  let targetAwaitStatement = null;

    // 3. 遍历 AST 查找 window.V_C.S 赋值
    traverse(ast, {
      AssignmentExpression(path) {
        const left = path.node.left;
        const right = path.node.right;

        // 检查是否是 window.V_C.S = ...
        if (
          t.isMemberExpression(left) &&
          t.isMemberExpression(left.object) &&
          t.isIdentifier(left.object.object, { name: 'window' }) &&
          t.isIdentifier(left.object.property, { name: 'V_C' }) &&
          t.isIdentifier(left.property, { name: 'S' })
        ) {
          // 4. 找到赋值右侧的 async 函数
          if (t.isArrowFunctionExpression(right) && right.async) {
            const functionBody = right.body;

            if (t.isBlockStatement(functionBody)) {
              // 5. 在函数体中查找 return 之前的 await 表达式
              // 从后往前找，找到第一个 let xxx = await xxx(...) 模式
              for (let i = functionBody.body.length - 1; i >= 0; i--) {
                const statement = functionBody.body[i];

                // 查找 let xxx = await yyy(...) 这样的模式
                if (
                  t.isVariableDeclaration(statement) &&
                  statement.declarations.length > 0
                ) {
                  const declarator = statement.declarations[0];

                  if (
                    t.isVariableDeclarator(declarator) &&
                    t.isAwaitExpression(declarator.init)
                  ) {
                    const awaitArg = declarator.init.argument;

                    // 检查是否是函数调用
                    if (t.isCallExpression(awaitArg)) {
                      const argsLength = awaitArg.arguments.length;

                      // 如果是3个参数：let q = await U.aOMyq(D, U.naYJr(k, T), G)
                      // 第一个参数是实际调用的函数，第二个参数才是我们要的
                      if (argsLength === 3) {
                        const secondArg = awaitArg.arguments[1];
                        if (secondArg) {
                          extractedData = extractIdentifiers(secondArg);
                        }
                      }
                      // 如果是2个参数：let q = await D(U.maxSO(k, T), G)
                      // 第一个参数就是我们要的
                      else if (argsLength >= 2) {
                        const firstArg = awaitArg.arguments[0];
                        if (firstArg) {
                          extractedData = extractIdentifiers(firstArg);
                        }
                      }

                      // 保存目标语句的索引，用于查找上一行
                      targetAwaitStatement = { body: functionBody.body, index: i };
                    }

                    break;
                  }
                }
              }
            }
          }
        }
      }
    });

  // 使用提取出的标识符进行后续处理
  if (extractedData && targetAwaitStatement) {
    const identifier1 = extractedData.type === 'binary' ? extractedData.left : extractedData.first;
    const identifier2 = extractedData.type === 'binary' ? extractedData.right : extractedData.second;

    if (identifier1 && identifier2) {
      const value1 = resolveIdentifierValue(ast, identifier1);
      const value2 = resolveIdentifierValue(ast, identifier2);

      const finalKey = value1 + value2;

      // 获取 S 值：查找 await 语句的上一行
      let sValue = null;
      const previousIndex = targetAwaitStatement.index - 1;

      if (previousIndex >= 0) {
        const previousStatement = targetAwaitStatement.body[previousIndex];

        // 检查上一行是否是 let G = U.rlkHf(v) 或 let G = v()
        if (
          t.isVariableDeclaration(previousStatement) &&
          previousStatement.declarations.length > 0
        ) {
          const declarator = previousStatement.declarations[0];

          if (t.isVariableDeclarator(declarator) && t.isCallExpression(declarator.init)) {
            const callExpr = declarator.init;
            let targetIdentifier = null;

            // 如果是直接函数调用 v()
            if (t.isIdentifier(callExpr.callee)) {
              targetIdentifier = callExpr.callee.name;
            }
            // 如果是成员方法调用且参数数量为1 U.rlkHf(v)
            else if (
              t.isMemberExpression(callExpr.callee) &&
              callExpr.arguments.length === 1 &&
              t.isIdentifier(callExpr.arguments[0])
            ) {
              targetIdentifier = callExpr.arguments[0].name;
            }

            if (targetIdentifier) {
              sValue = extractSValue(ast, targetIdentifier);
            }
          }
        }
      }

      // 查找 window.V_C.push 调用，提取参数
      let pushParams = null;

      traverse(ast, {
        CallExpression(path) {
          const callee = path.node.callee;

          // 检查是否是 window.V_C.push(...)
          if (
            t.isMemberExpression(callee) &&
            t.isMemberExpression(callee.object) &&
            t.isIdentifier(callee.object.object, { name: 'window' }) &&
            t.isIdentifier(callee.object.property, { name: 'V_C' }) &&
            t.isIdentifier(callee.property, { name: 'push' })
          ) {
            // 获取 push 的第一个参数（箭头函数）
            const firstArg = path.node.arguments[0];

            if (t.isArrowFunctionExpression(firstArg)) {
              const arrowBody = firstArg.body;

              // 箭头函数体应该是一个函数调用 X(...)
              if (t.isCallExpression(arrowBody)) {
                // 提取所有参数的值
                pushParams = arrowBody.arguments.map(arg => {
                  if (t.isNumericLiteral(arg)) {
                    return arg.value;
                  } else if (t.isStringLiteral(arg)) {
                    return arg.value;
                  } else if (t.isBooleanLiteral(arg)) {
                    return arg.value;
                  } else if (t.isNullLiteral(arg)) {
                    return null;
                  } else {
                    return null; // 其他类型暂不处理
                  }
                });

                path.stop();
              }
            }
          }
        }
      });

      // 返回结果
      return {
        key: finalKey,
        params: pushParams,
        s: sValue
      };
    }
  }

  throw new Error('Failed to extract data');
}

// POST /get_key 接口
app.post('/get_key', async (req, res) => {
  try {
    const { jscode } = req.body;

    if (!jscode) {
      return res.status(400).json({ error: 'jscode is required' });
    }

    const result = await processJsCode(jscode);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /get_x_is_human 接口
app.post('/get_x_is_human', async (req, res) => {
  try {
    const { jscode, fp } = req.body;

    if (!jscode) {
      return res.status(400).json({ error: 'jscode is required' });
    }

    if (!fp) {
      return res.status(400).json({ error: 'fp is required' });
    }

    // 1. 调用 get_key 获取参数
    const keyResult = await processJsCode(jscode);
    const { key, params, s } = keyResult;

    if (!params || params.length < 5) {
      return res.status(500).json({ error: 'Invalid params from get_key' });
    }

    // 2. 构建 Y 对象
    const Y = {
      p: false,
      S: s,
      w: {
        v: fp.UNMASKED_RENDERER_WEBGL,
        r: fp.UNMASKED_VENDOR_WEBGL
      },
      s: false,
      h: false,
      b: false,
      d: false
    };

    // 3. 调用 D 函数进行加密
    const encryptedData = await encryptData(key, Y);

    // 4. 构建最终响应
    const response = {
      b: params[0],
      v: params[2],
      e: params[3],
      s: encryptedData,
      d: params[1],
      vr: params[4]
    };

    res.json(response);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// D 函数：使用 PBKDF2 + AES-GCM 加密
async function encryptData(H, Y) {
  // 1. 生成 16 字节随机盐值
  const X = crypto.getRandomValues(new Uint8Array(16));

  // 2. 生成 12 字节随机 IV (初始化向量)
  const P = crypto.getRandomValues(new Uint8Array(12));

  // 3. 将密码字符串 H 导入为密钥材料
  const O = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(H),
    "PBKDF2",
    false,
    ["deriveBits", "deriveKey"]
  );

  // 4. 使用 PBKDF2 派生 AES-256 密钥
  const G = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: X,
      iterations: 100000,
      hash: "SHA-256"
    },
    O,
    {
      name: "AES-GCM",
      length: 256
    },
    false,
    ["encrypt"]
  );

  // 5. 使用 AES-GCM 加密数据
  const dataString = JSON.stringify(Y);
  const dataBytes = new TextEncoder().encode(dataString);

  const encryptedData = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: P
    },
    G,
    dataBytes
  );

  // 6. 组合 salt + iv + ciphertext 并转为 base64
  const saltArray = Array.from(X);
  const ivArray = Array.from(P);
  const ciphertextArray = Array.from(new Uint8Array(encryptedData));

  const combined = new Uint8Array([...saltArray, ...ivArray, ...ciphertextArray]);

  // 转为 base64
  return Buffer.from(combined).toString('base64');
}

// 提取 S 值
function extractSValue(ast, functionName) {
  // 查找函数声明
  let functionDeclaration = null;

  traverse(ast, {
    FunctionDeclaration(path) {
      if (t.isIdentifier(path.node.id, { name: functionName })) {
        functionDeclaration = path;
        path.stop();
      }
    }
  });

  if (!functionDeclaration) {
    throw new Error(`Function "${functionName}" not found`);
  }

  const functionBody = functionDeclaration.node.body;

  // 查找 return 语句
  for (const statement of functionBody.body) {
    if (t.isReturnStatement(statement)) {
      const returnArg = statement.argument;

      // return 后面应该是一个 ObjectExpression
      if (t.isObjectExpression(returnArg)) {
        // 查找属性名为 S 的属性
        for (const prop of returnArg.properties) {
          if (
            t.isObjectProperty(prop) &&
            t.isIdentifier(prop.key) &&
            prop.key.name === 'S'
          ) {
            const value = prop.value;

            // 如果是二元运算符，且两个都是数字字面量
            if (
              t.isBinaryExpression(value) &&
              t.isNumericLiteral(value.left) &&
              t.isNumericLiteral(value.right)
            ) {
              // 计算两者相乘
              return value.left.value * value.right.value;
            }

            // 如果是 CallExpression，callee 是 MemberExpression，参数个数为2都是数字字面量
            if (
              t.isCallExpression(value) &&
              t.isMemberExpression(value.callee) &&
              value.arguments.length === 2 &&
              t.isNumericLiteral(value.arguments[0]) &&
              t.isNumericLiteral(value.arguments[1])
            ) {
              // 计算两个参数相乘
              return value.arguments[0].value * value.arguments[1].value;
            }

            throw new Error('Unsupported S value type');
          }
        }
      }

      throw new Error('S property not found in return object');
    }
  }

  throw new Error('Return statement not found in function');
}

// 解析标识符的最终值
function resolveIdentifierValue(ast, identifierName) {
  let binding = null;

  // 查找标识符的绑定
  traverse(ast, {
    VariableDeclarator(path) {
      if (t.isIdentifier(path.node.id, { name: identifierName })) {
        binding = path;
        path.stop();
      }
    }
  });

  if (!binding) {
    throw new Error(`Identifier "${identifierName}" not found`);
  }

  // 查找所有修改点（不包括初始化）
  const modifications = [];
  const bindingPath = binding;

  traverse(ast, {
    AssignmentExpression(path) {
      if (t.isIdentifier(path.node.left, { name: identifierName })) {
        modifications.push(path);
      }
    }
  });

  if (modifications.length !== 1) {
    throw new Error(`Expected 1 modification for "${identifierName}", found ${modifications.length}`);
  }

  // 获取赋值右值
  const rightValue = modifications[0].node.right;

  return extractValue(ast, rightValue);
}

// 提取值（处理字符串字面量和 MemberExpression）
function extractValue(ast, node) {
  // 如果是字符串字面量，直接返回
  if (t.isStringLiteral(node)) {
    return node.value;
  }

  // 如果是 MemberExpression，例如 U.KXxUX
  if (t.isMemberExpression(node)) {
    const objectName = t.isIdentifier(node.object) ? node.object.name : null;
    const propertyName = t.isIdentifier(node.property) ? node.property.name : null;

    if (!objectName || !propertyName) {
      throw new Error('Invalid MemberExpression');
    }

    // 查找 object 的绑定，应该是一个 ObjectExpression
    let objectBinding = null;

    traverse(ast, {
      VariableDeclarator(path) {
        if (t.isIdentifier(path.node.id, { name: objectName })) {
          objectBinding = path;
          path.stop();
        }
      }
    });

    if (!objectBinding) {
      throw new Error(`Object "${objectName}" not found`);
    }

    const objectInit = objectBinding.node.init;

    if (!t.isObjectExpression(objectInit)) {
      throw new Error(`"${objectName}" is not an ObjectExpression`);
    }

    // 根据 property.name 查找对应的值
    const property = objectInit.properties.find(prop =>
      t.isObjectProperty(prop) &&
      t.isIdentifier(prop.key, { name: propertyName })
    );

    if (!property) {
      throw new Error(`Property "${propertyName}" not found in "${objectName}"`);
    }

    // 递归提取值
    return extractValue(ast, property.value);
  }

  throw new Error('Unsupported value type');
}

// 辅助函数：从第一个参数中提取标识符
function extractIdentifiers(node) {
  // 如果第一个参数是二元运算 A + B
  if (t.isBinaryExpression(node)) {
    return {
      type: 'binary',
      operator: node.operator,
      left: t.isIdentifier(node.left) ? node.left.name : null,
      right: t.isIdentifier(node.right) ? node.right.name : null
    };
  }

  // 如果第一个参数是函数调用 U.maxSO(k, T)
  if (t.isCallExpression(node)) {
    const args = node.arguments;

    if (args.length >= 2) {
      const firstParam = args[0];
      const secondParam = args[1];

      // 提取两个参数的标识符
      return {
        type: 'function_call',
        first: t.isIdentifier(firstParam) ? firstParam.name : null,
        second: t.isIdentifier(secondParam) ? secondParam.name : null
      };
    }
  }

  return null;
}

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});